import type { Db } from '../../shared/db';
import type { PaymentGateway } from './payment-gateway';
import {
  listPendingRefunds,
  markRefunded,
  PAYMENT_EXPIRED_REASON,
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
 * Правила (issue #8):
 * - условия отбора стоят в `WHERE` самого `UPDATE`, а не в отдельном чтении: между
 *   «проверил» и «записал» нет окна, поэтому параллельный вебхук оплаты либо успевает
 *   подтвердить запись (она уже не попадает в выборку), либо видит её отменённой
 *   и запускает возврат;
 * - отменяются только `pending`-платежи: `succeeded` не трогаем — деньги вернёт обработчик
 *   уведомления, а если возврат там не удался — флаг `refund_required` и следующий тик;
 * - обязательные возвраты (`payments.refund_required`) повторяются тем же тиком: сбой шлюза
 *   в момент уведомления не теряет деньги клиента. Ключ идемпотентности тот же, что в маршруте
 *   (`refund-<paymentId>`), поэтому повтор не возвращает деньги дважды;
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
  /** Шлюз платежей: нужен для повтора обязательных возвратов. */
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
  /** Сколько обязательных возвратов попытались повторить (включая неудачные). */
  refundsRetried: number;
  /** Сколько возвратов завершилось: платёж `refunded`, флаг снят. */
  refundsCompleted: number;
}

export interface HoldsSweeper {
  readonly intervalMs: number;
  /** Один проход. `now` подменяется в тестах; по умолчанию — текущий момент. */
  tick(now?: Date): Promise<HoldsSweeperTickResult>;
}

const emptyResult = (): HoldsSweeperTickResult => ({
  expired: 0,
  paymentsCanceled: 0,
  refundsRetried: 0,
  refundsCompleted: 0,
});

/** Имя ошибки без сообщения: текст исключения БД может содержать значения строк. */
function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * Истёкшие холды: запись `cancelled(payment_expired)`, её платёж `canceled`.
 * Одна транзакция: слот освобождается вместе со статусом платежа.
 */
async function expireHolds(
  db: Db,
  now: Date,
  logger: HoldsSweeperLogger,
): Promise<Pick<HoldsSweeperTickResult, 'expired' | 'paymentsCanceled'>> {
  return db.$transaction(async (tx) => {
    // Один UPDATE с условиями в WHERE: список истёкших записей не читается заранее,
    // поэтому запись, оплаченную между тиками, свипер не отменит.
    const expired = await tx.appointment.updateManyAndReturn({
      where: { status: 'pending', paymentDeadlineAt: { lte: now } },
      data: { status: 'cancelled', cancelReason: PAYMENT_EXPIRED_REASON },
      select: { id: true },
    });

    const appointmentIds = expired.map((row) => row.id);
    if (appointmentIds.length === 0) return { expired: 0, paymentsCanceled: 0 };

    const payments = await tx.payment.updateMany({
      where: { appointmentId: { in: appointmentIds }, status: 'pending' },
      data: { status: 'canceled' },
    });

    logger.info(
      {
        expired: appointmentIds.length,
        paymentsCanceled: payments.count,
        appointmentIds,
      },
      'истёкшие холды оплаты отменены',
    );

    return { expired: appointmentIds.length, paymentsCanceled: payments.count };
  });
}

/**
 * Повтор обязательных возвратов. Сеть, а не транзакция: вызов шлюза идёт вне её.
 *
 * Ошибка одного возврата не ломает тик и не мешает остальным: неудача остаётся флагом
 * в БД, и следующий тик повторит возврат с тем же ключом идемпотентности.
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

  return {
    intervalMs: deps.intervalMs,

    async tick(now: Date = new Date()): Promise<HoldsSweeperTickResult> {
      try {
        // Сначала холды (одна транзакция), потом возвраты (сеть). Возвраты идут даже если
        // истёкших холдов нет: флаг мог остаться от сбоя шлюза в обработчике уведомления.
        const holds = await expireHolds(db, now, logger);
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
