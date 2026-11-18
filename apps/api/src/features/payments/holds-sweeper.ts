import type { Db } from '../../shared/db';
import type { GatewayPayment, PaymentGateway } from './payment-gateway';
import {
  applyPaymentSucceeded,
  HOLDS_RECONCILE_LIMIT,
  listPendingRefunds,
  markRefunded,
  markRefundRequired,
  PAYMENT_EXPIRED_REASON,
  recordRefundAttempt,
  refundIdempotenceKey,
  type PendingRefund,
} from './payments.service';

/**
 * Свипер истёкших холдов оплаты.
 *
 * Запись с обязательной оплатой создаётся `pending` с `payment_deadline_at = now + 15 мин`.
 * Если деньги не пришли, по истечении срока запись отменяется (`cancelled`,
 * причина `payment_expired`), а платёж переводится в `canceled`. Слот освобождается сам:
 * EXCLUDE-констрейнт занятости смотрит только на записи со статусом `<> 'cancelled'`.
 *
 * Правила (issue #8, #104):
 * - перед отменой состояние платежа сверяется со шлюзом (`getPayment`): клиент мог оплатить
 *   в последнюю секунду, а вебхук — ещё не дойти. Оплата применяется тем же переходом, что
 *   и в обработчике уведомления (`applyPaymentSucceeded`) — письмо и идемпотентность те же;
 * - условия отбора стоят в `WHERE` финального `UPDATE`, а не только в чтении: между сверкой
 *   и записью есть окно (сеть), но параллельный вебхук и отмена разведены несовместимыми
 *   `WHERE` — выигрывает ровно один, проигравший видит `count === 0`;
 * - ошибка шлюза (сеть, не-2xx, несовпадение суммы) — не повод отменять: запись остаётся
 *   `pending` и попадает в следующий тик. Отменять платёж по догадке нельзя — деньги уже
 *   могли уйти;
 * - очередь не блокируется неизвестным состоянием: запись, чья сверка не удалась (`getPayment`
 *   бросил, `succeeded` без `paid`), запоминается в памяти процесса и в следующем тике
 *   пропускается — сверяются следующие по дедлайну кандидаты. Набор отложенных ограничен
 *   `MAX_DEFERRED_RECONCILES` и работает как очередь: вытесненная запись снова участвует
 *   в отборе, то есть и отложенные перепроверяются по кругу. Один экземпляр `api` —
 *   допущение развёртывания, многоинстансовость не требование (AGENTS.md);
 * - отменяются только `pending`-платежи: `succeeded` не отменяем — сверка подтверждает запись
 *   тем же переходом, что и уведомление, а если запись уже отменена — флаг `refund_required`
 *   и возврат тем же тиком;
 * - обязательные возвраты (`payments.refund_required`) повторяются тем же тиком: сбой шлюза
 *   в момент уведомления не теряет деньги клиента. Ключ идемпотентности тот же, что в маршруте
 *   (`refund-<paymentId>`), поэтому повтор не возвращает деньги дважды;
 * - возврат считается завершённым только при `succeeded`: `pending` (деньги ещё в пути),
 *   `canceled` (провайдер отказал) и `unknown` оставляют флаг в БД. Такой возврат посчитан
 *   попытанным, но не `refundsCompleted`, и будет повторён следующим тиком;
 * - тик не бросает исключений наружу: недоступная БД лечится следующим тиком, процесс живёт;
 * - в лог попадают только количества, id платежей и имена ошибок: ни сумм, ни персональных данных.
 */

/** Минимальный интерфейс логгера: pino из Fastify подходит без адаптера. */
export interface HoldsSweeperLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface HoldsSweeperDeps {
  db: Db;
  /** Шлюз платежей: сверка состояния платежа перед отменой и повтор обязательных возвратов. */
  gateway: PaymentGateway;
  /** Период тика (`PAYMENT_SWEEP_INTERVAL_MS`). Плагин запускает по нему интервал. */
  intervalMs: number;
  logger: HoldsSweeperLogger;
}

export interface HoldsSweeperTickResult {
  /** Сколько записей отменено как неоплаченные. */
  expired: number;
  /** Сколько платежей переведено в `canceled`. */
  paymentsCanceled: number;
  /** Сколько платежей сверено со шлюзом за тик (успешных вызовов `getPayment`). */
  reconciled: number;
  /** Сколько платежей подтверждено сверкой (`applyPaymentSucceeded`). */
  confirmed: number;
  /** Сколько обязательных возвратов попытались повторить (включая неудачные). */
  refundsRetried: number;
  /** Сколько возвратов завершилось подтверждённым `succeeded`: платёж `refunded`, флаг снят. */
  refundsCompleted: number;
}

export interface HoldsSweeper {
  readonly intervalMs: number;
  /** Один проход. `now` подменяется в тестах; по умолчанию — текущий момент. */
  tick(now?: Date): Promise<HoldsSweeperTickResult>;
}

/**
 * Глубина набора отложенных записей: граница памяти, а не размер окна выборки.
 *
 * Тик читает полный список истёкших id, отложенные фильтруются в памяти, а лимит сверки
 * (`HOLDS_RECONCILE_LIMIT`) применяется уже к не-отложенным. Пока постоянно падающих сверок
 * меньше этой границы, отложенный набор не вытесняется и хвост бэклога остаётся достижимым.
 * При числе падающих сверок не меньше границы память ограничена вытеснением: вытесненная
 * запись снова участвует в отборе, поэтому прогресс есть, но гарантии «хвост за границей
 * достижим» нет — это остаточное ограничение (follow-up), а не решённый здесь случай.
 *
 * Ротация (`retried`) возвращает одну отложенную запись в отбор каждый тик: она нужна
 * не для обхода бэклога, а чтобы отложенная запись перепроверялась, не дожидаясь вытеснения.
 */
const MAX_DEFERRED_RECONCILES = HOLDS_RECONCILE_LIMIT * 10;

const emptyResult = (): HoldsSweeperTickResult => ({
  expired: 0,
  paymentsCanceled: 0,
  reconciled: 0,
  confirmed: 0,
  refundsRetried: 0,
  refundsCompleted: 0,
});

/** Имя ошибки без сообщения: текст исключения БД может содержать значения строк. */
function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * Истёкшие холды: сверка с шлюзом, затем запись `cancelled(payment_expired)` и её платёж `canceled`.
 *
 * Порядок задан двумя ограничениями. Сеть нельзя держать в транзакции — поэтому состояния
 * платежей читаются до неё, и кандидаты лишь отбираются (`orderBy` по дедлайну, сверка —
 * не больше `HOLDS_RECONCILE_LIMIT` за тик), а не отменяются. Отмена, в свою очередь, идёт
 * одним условным `UPDATE`: если между сверкой и записью запись успел оплатить вебхук,
 * она уже не `pending` и в выборку не попадает.
 *
 * Неизвестное состояние (ошибка шлюза, `succeeded` без `paid`) — не повод отменять: запись
 * откладывается (`deferred`) и в следующем тике пропускается в отборе, а сверяются следующие
 * по дедлайну кандидаты. Платёж без `yookassa_payment_id` (создание в шлюзе не удалось)
 * и запись без платежа отменяются без вызова шлюза — денег там нет.
 */
async function expireHolds(
  db: Db,
  gateway: PaymentGateway,
  now: Date,
  logger: HoldsSweeperLogger,
  deferred: Set<string>,
): Promise<
  Pick<HoldsSweeperTickResult, 'expired' | 'paymentsCanceled' | 'reconciled' | 'confirmed'>
> {
  // Отложенные перепроверяются по кругу: самая старая запись каждый тик возвращается в отбор.
  // Без этого запись с постоянно падающей сверкой осталась бы в наборе навсегда и больше
  // никогда не сверялась (и наоборот — без пропуска падающая голова держала бы очередь).
  const retried = deferred.values().next().value;
  if (retried !== undefined) deferred.delete(retried);

  // Полный список истёкших id: отложенные фильтруются в памяти. `take` здесь нет
  // сознательно — окно выборки, пересечённое с набором отложенных, отсекало бы хвост
  // бэклога, до которого тик тогда не доходит никогда. Лимит сверки применяется ниже,
  // уже к не-отложенным кандидатам.
  const candidates = await db.appointment.findMany({
    where: { status: 'pending', paymentDeadlineAt: { lte: now } },
    orderBy: { paymentDeadlineAt: 'asc' },
    select: { id: true },
  });
  if (candidates.length === 0) {
    // Истёкших холдов нет: отложенное больше не актуально (запись оплачена, отменена
    // или дедлайн сдвинут), иначе набор рос бы на перезапусках нагрузки.
    deferred.clear();
    return { expired: 0, paymentsCanceled: 0, reconciled: 0, confirmed: 0 };
  }

  const fetched = new Set(candidates.map((row) => row.id));
  // Запись, которой нет в выборке, отложенной быть не может: её больше нечего сверять
  // (оплачена, отменена или дедлайн сдвинут). Без этого набор занимал бы окно вечно.
  for (const appointmentId of deferred) {
    if (!fetched.has(appointmentId)) deferred.delete(appointmentId);
  }

  /**
   * Отложить запись до следующего тика: в конец очереди, с ограничением её длины.
   * Вытесненная (самая старая) запись снова участвует в отборе — так неудачная сверка
   * не залипает навсегда даже при постоянно падающем шлюзе.
   */
  const defer = (appointmentId: string): void => {
    deferred.delete(appointmentId);
    deferred.add(appointmentId);
    while (deferred.size > MAX_DEFERRED_RECONCILES) {
      const oldest = deferred.values().next().value;
      if (oldest === undefined) break;
      deferred.delete(oldest);
    }
  };

  const candidateIds = candidates
    .map((row) => row.id)
    .filter((id) => !deferred.has(id))
    .slice(0, HOLDS_RECONCILE_LIMIT);
  // Только служебные поля: сумма нужна для сверки, id провайдера — для вызова шлюза.
  // Персональные данные платежа не читаются.
  const payments = await db.payment.findMany({
    where: { appointmentId: { in: candidateIds }, status: 'pending' },
    select: { id: true, appointmentId: true, amountKopecks: true, yookassaPaymentId: true },
  });
  // Платёж у записи один (unique `appointment_id`), поэтому карта, а не поиск в цикле.
  const paymentByAppointment = new Map(payments.map((row) => [row.appointmentId, row]));

  let reconciled = 0;
  let confirmed = 0;
  const cancelIds: string[] = [];

  for (const appointmentId of candidateIds) {
    const payment = paymentByAppointment.get(appointmentId);
    if (payment === undefined || payment.yookassaPaymentId === null) {
      cancelIds.push(appointmentId);
      continue;
    }

    try {
      const state: GatewayPayment = await gateway.getPayment(payment.yookassaPaymentId);
      reconciled += 1;

      if (state.status === 'succeeded') {
        // `succeeded` без `paid` — неоплаченное подтверждение: считаем состояние неизвестным
        // и запись не отменяем, чтобы не потерять оплату и не освободить оплаченный слот.
        if (!state.paid) {
          defer(appointmentId);
          logger.warn(
            { paymentId: payment.id, gatewayStatus: state.status },
            'шлюз вернул succeeded без paid: состояние не считаем оплатой, запись ждёт',
          );
          continue;
        }

        // Тот же путь, что у уведомления: подтверждение записи, письмо в outbox,
        // возврат при уже отменённой записи. Сверка лишь заменила источник истины.
        const transition = await applyPaymentSucceeded(db, payment.id, {
          amountKopecks: state.amountKopecks,
        });
        if (transition === null) {
          deferred.delete(appointmentId);
          continue;
        }

        // Запись уже отменена (клиент или салон): подтвердить нельзя, деньги возвращаем.
        // Флаг снимает `retryPendingRefunds` того же тика — ключ `refund-<paymentId>` идемпотентен.
        if (transition.needsRefund) await markRefundRequired(db, payment.id);
        // Подтверждение снимет запись с очереди: откладывать больше нечего.
        deferred.delete(appointmentId);
        // `changed: false` — платёж уже не `pending`: его успел подтвердить вебхук между
        // выборкой и ответом шлюза. Сверка лишь увидела готовое состояние, поэтому
        // ни счётчик, ни лог «подтверждена сверкой» этот переход не засчитывают.
        if (!transition.changed) continue;
        confirmed += 1;
        logger.info(
          { paymentId: payment.id, appointmentId: transition.appointmentId },
          'оплата подтверждена сверкой перед истечением холда',
        );
        continue;
      }

      // `pending`/`canceled`: денег нет, холд истекает как обычно.
      deferred.delete(appointmentId);
      cancelIds.push(appointmentId);
    } catch (error) {
      // Сеть, не-2xx или несовпадение суммы: состояние неизвестно, запись не трогаем, но
      // откладываем — иначе падающая голова выборки держала бы очередь вечно.
      // В лог — только id платежа и имя ошибки: сумма и тела ответов не пишутся.
      defer(appointmentId);
      logger.error(
        { paymentId: payment.id, errorName: errorNameOf(error) },
        'сверка платежа с шлюзом не удалась, запись оставлена ждать следующего тика',
      );
    }
  }

  if (cancelIds.length === 0) {
    return { expired: 0, paymentsCanceled: 0, reconciled, confirmed };
  }

  // Одна транзакция: слот освобождается вместе со статусом платежа. Условия стоят в WHERE,
  // поэтому опоздавшая оплата (уже `confirmed`) или сдвинутый дедлайн не отменяются.
  const canceled = await db.$transaction(async (tx) => {
    const expired = await tx.appointment.updateManyAndReturn({
      where: { id: { in: cancelIds }, status: 'pending', paymentDeadlineAt: { lte: now } },
      data: { status: 'cancelled', cancelReason: PAYMENT_EXPIRED_REASON },
      select: { id: true },
    });

    const appointmentIds = expired.map((row) => row.id);
    if (appointmentIds.length === 0) return { appointmentIds, paymentsCanceled: 0 };

    const paymentsCanceled = await tx.payment.updateMany({
      where: { appointmentId: { in: appointmentIds }, status: 'pending' },
      data: { status: 'canceled' },
    });

    return { appointmentIds, paymentsCanceled: paymentsCanceled.count };
  });

  if (canceled.appointmentIds.length > 0) {
    logger.info(
      {
        expired: canceled.appointmentIds.length,
        paymentsCanceled: canceled.paymentsCanceled,
        reconciled,
        appointmentIds: canceled.appointmentIds,
      },
      'истёкшие холды оплаты отменены',
    );
  }

  return {
    expired: canceled.appointmentIds.length,
    paymentsCanceled: canceled.paymentsCanceled,
    reconciled,
    confirmed,
  };
}

/**
 * Повтор обязательных возвратов. Сеть, а не транзакция: вызов шлюза идёт вне её.
 *
 * Ошибка одного возврата не ломает тик и не мешает остальным: неудача остаётся флагом
 * в БД, и следующий тик повторит возврат с тем же ключом идемпотентности.
 *
 * Завершённым считается только `succeeded`: `pending`/`canceled`/`unknown` флаг не снимает
 * и в `refundsCompleted` не попадает — иначе обязанность вернуть деньги потерялась бы,
 * хотя деньги клиенту ещё не вернулись.
 */
async function retryPendingRefunds(
  db: Db,
  gateway: PaymentGateway,
  logger: HoldsSweeperLogger,
): Promise<Pick<HoldsSweeperTickResult, 'refundsRetried' | 'refundsCompleted'>> {
  const pending: PendingRefund[] = await listPendingRefunds(db);
  if (pending.length === 0) return { refundsRetried: 0, refundsCompleted: 0 };

  let completed = 0;
  for (const item of pending) {
    try {
      const refund = await gateway.createRefund({
        yookassaPaymentId: item.yookassaPaymentId,
        amountKopecks: item.amountKopecks,
        // Тот же ключ, что в маршруте уведомления: повтор не вернёт деньги дважды.
        idempotenceKey: refundIdempotenceKey(item.paymentId),
      });
      if (refund.status !== 'succeeded') {
        // Флаг в БД не трогаем: возврат не завершён, следующий тик повторит его.
        // Фактический статус провайдера пишем: `canceled` виден в БД (обзор требующих
        // внимания), а не только в логе, и отличается от NULL («попыток не было»).
        await recordRefundAttempt(db, item.paymentId, refund.refundId, refund.status);
        logger.error(
          {
            paymentId: item.paymentId,
            refundId: refund.refundId,
            refundStatus: refund.status,
          },
          refund.status === 'canceled'
            ? 'возврат отклонён провайдером, нужна ручная проверка'
            : 'возврат не завершён, повторим',
        );
        continue;
      }

      await markRefunded(db, item.paymentId, refund.refundId);
      completed += 1;
      logger.info(
        { paymentId: item.paymentId, refundId: refund.refundId },
        'обязательный возврат выполнен',
      );
    } catch (error) {
      // В лог — только id платежа и имя ошибки: сумма и тела ответов провайдера не пишутся.
      logger.error(
        { paymentId: item.paymentId, errorName: errorNameOf(error) },
        'повтор обязательного возврата не удался, повторим следующим тиком',
      );
    }
  }

  logger.info(
    { refundsRetried: pending.length, refundsCompleted: completed },
    'обязательные возвраты обработаны',
  );

  return { refundsRetried: pending.length, refundsCompleted: completed };
}

/**
 * Фабрика свипера. Ошибки тика логируются и гасятся: наружу не выходит ни одно исключение.
 */
export function createHoldsSweeper(deps: HoldsSweeperDeps): HoldsSweeper {
  const { db, gateway, logger } = deps;
  // Записи с неудавшейся сверкой, отложенные на следующий тик. Состояние живёт в памяти
  // процесса: допущение — один экземпляр `api` (AGENTS.md), многоинстансовость не требование.
  const deferred = new Set<string>();

  return {
    intervalMs: deps.intervalMs,

    async tick(now: Date = new Date()): Promise<HoldsSweeperTickResult> {
      try {
        // Сначала холды (сверка с шлюзом и одна транзакция отмены), потом возвраты (сеть).
        // Возвраты идут даже если истёкших холдов нет: флаг мог остаться от сбоя шлюза
        // в обработчике уведомления.
        const holds = await expireHolds(db, gateway, now, logger, deferred);
        const refunds = await retryPendingRefunds(db, gateway, logger);
        return { ...holds, ...refunds };
      } catch (error) {
        logger.error(
          { errorName: errorNameOf(error) },
          'тик свипера холдов оплаты прерван ошибкой, повторим следующим тиком',
        );
        return emptyResult();
      }
    },
  };
}
