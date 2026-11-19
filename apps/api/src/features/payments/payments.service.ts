import type { BookingStatus, PaymentStatus, RefundClientStatus } from '@hair-lab/contracts';
import type { Prisma } from '../../generated/prisma/client';
import type { Db } from '../../shared/db';
import { BOOKING_CONFIRMATION_TYPE, buildBookingConfirmationPayload } from '../bookings/index';
import type { GatewayRefundStatus } from './payment-gateway';

/**
 * Доменная логика оплаты записи: переходы статусов платежа и связанной записи.
 *
 * Правила (issue #8):
 * - платёж и запись меняются в одной транзакции: не бывает «деньги приняты, а запись pending»;
 * - переход идемпотентен: повторное уведомление провайдера при терминальном статусе —
 *   no-op с текущим состоянием, а не ошибка. ЮKassa повторяет уведомления до 24 часов;
 * - проверка и запись — одним условным `UPDATE ... WHERE` (статус в `WHERE`), поэтому окна
 *   «прочитал → записал» нет: выигрывает ровно один из параллельных обработчиков;
 * - оплата пришла после отмены записи (холд истёк) → `needsRefund`: деньги возвращает
 *   вызывающий через шлюз, доменная логика сама в сеть не ходит;
 * - сбой возврата не теряется: обязанность вернуть деньги живёт в БД (`payments.refund_required`)
 *   и снимается только вместе с переходом в `refunded`, а повторяет возврат свипер;
 * - персональные данные читаются только для снимка письма-подтверждения и остаются в БД;
 *   в логи и в результат они не попадают.
 */

/** Причина отмены записи, когда платёж отменён (клиентом или провайдером). */
export const PAYMENT_CANCELED_REASON = 'payment_canceled';

/** Причина отмены записи, когда истёк срок оплаты (холд снят свипером). */
export const PAYMENT_EXPIRED_REASON = 'payment_expired';

/** Причина отмены записи, когда платёж не удалось создать в шлюзе (после коммита записи). */
export const PAYMENT_CREATION_FAILED_REASON = 'payment_creation_failed';

/**
 * Сколько минут слот держится за неоплаченной записью (решение владельца — 15 минут).
 * Значение живёт в коде, а не в окружении: это продуктовое правило, а не настройка среды.
 */
export const PAYMENT_HOLD_MINUTES = 15;

const MINUTE_MS = 60_000;

/**
 * Ключ идемпотентности возврата. Возврат один на платёж, а наш id платежа стабилен:
 * повтор (в том числе из свипера) не вернёт деньги дважды. Одна точка расчёта на все вызовы —
 * маршрут уведомления и свипер обязаны отправлять один и тот же ключ.
 */
export function refundIdempotenceKey(paymentId: string): string {
  return `refund-${paymentId}`;
}

/**
 * Сколько обязательных возвратов пробует один тик свипера. Ограничение — чтобы недоступный
 * шлюз не держал тик минутами; остальные строки подхватит следующий тик.
 */
export const PENDING_REFUNDS_LIMIT = 5;

/**
 * Сколько истёкших холдов один тик свипера сверяет со шлюзом. Ограничение сети, а не выборки:
 * столько же последовательных `getPayment` тик и делает, поэтому недоступный ЮKassa не держит
 * его минутами. Остальные холды остаются `pending` и уходят на следующий тик — отбор идёт
 * по старшинству дедлайна, так что никто не ждёт вечно.
 *
 * Значение — продуктовое правило, а не настройка среды (как и `PENDING_REFUNDS_LIMIT`):
 * пиковый холд (15 минут) дренируется за 1–2 тика при интервале 30 с.
 */
export const HOLDS_RECONCILE_LIMIT = 20;

/**
 * Дедлайн холда: `now + PAYMENT_HOLD_MINUTES`.
 *
 * Одна точка расчёта: то же значение уходит в `appointments.payment_deadline_at`, в ответ
 * `POST /bookings` (`payment.expiresAt`) и в свипер. `now` подменяется в тестах.
 */
export function paymentHoldDeadline(
  now: Date = new Date(),
  minutes: number = PAYMENT_HOLD_MINUTES,
): Date {
  return new Date(now.getTime() + minutes * MINUTE_MS);
}

/**
 * Строка платежа-холда в транзакции создания записи.
 *
 * Пишется в одной транзакции с записью, поэтому «запись без платежа» и «платёж без записи»
 * невозможны. `yookassa_payment_id` и `confirmation_url` появятся позже: платёж в шлюзе
 * создаётся после коммита, вне транзакции (сетевой вызов не держит транзакцию открытой).
 * Сумма — снимок цены услуги в копейках, а не значение от клиента.
 */
export async function createPaymentHold(
  tx: Prisma.TransactionClient,
  input: { appointmentId: string; amountKopecks: number },
): Promise<{ paymentId: string }> {
  const payment = await tx.payment.create({
    data: {
      appointmentId: input.appointmentId,
      amountKopecks: input.amountKopecks,
      status: 'pending',
    },
    select: { id: true },
  });
  return { paymentId: payment.id };
}

/**
 * Сохранение данных платежа, полученных от шлюза (после коммита записи).
 * `yookassa_payment_id` нужен для вебхука: по нему находится наша строка платежа.
 */
export async function savePaymentDetails(
  db: Db,
  paymentId: string,
  input: { yookassaPaymentId: string; confirmationUrl: string },
): Promise<void> {
  await db.payment.update({
    where: { id: paymentId },
    data: {
      yookassaPaymentId: input.yookassaPaymentId,
      confirmationUrl: input.confirmationUrl,
    },
  });
}

/**
 * Компенсация сбоя шлюза: запись отменяется (слот освобождается), платёж — `canceled`.
 *
 * Холд без ссылки на оплату держать нельзя: клиент не может заплатить, а слот занят.
 * Условия стоят в самих `WHERE`: запись, которую успели подтвердить, не отменяется.
 */
export async function failPaymentCreation(db: Db, appointmentId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.appointment.updateMany({
      where: { id: appointmentId, status: 'pending' },
      data: {
        status: 'cancelled',
        cancelReason: PAYMENT_CREATION_FAILED_REASON,
        paymentDeadlineAt: null,
      },
    });
    await tx.payment.updateMany({
      where: { appointmentId, status: 'pending' },
      data: { status: 'canceled' },
    });
  });
}

/** Наша строка платежа по id платежа провайдера — вместе с суммой для сверки. */
export interface PaymentLookup {
  paymentId: string;
  amountKopecks: number;
}

/**
 * Платёж по id ЮKassa. `null` — уведомление не про нас (или данные шлюза ещё не сохранены).
 * Читаются только служебные поля: ни персональных данных, ни описаний.
 */
export async function findPaymentByYookassaId(
  db: Db,
  yookassaPaymentId: string,
): Promise<PaymentLookup | null> {
  const payment = await db.payment.findUnique({
    where: { yookassaPaymentId },
    select: { id: true, amountKopecks: true },
  });
  return payment === null ? null : { paymentId: payment.id, amountKopecks: payment.amountKopecks };
}

/**
 * Сумма из уведомления/шлюза не совпадает с суммой платежа: деньги приняты не по нашему
 * расчёту, поэтому переход не выполняется. Суммы в тексте ошибки нет — она попадает в лог
 * вызывающего, если он решит её записать.
 */
export class PaymentAmountMismatchError extends Error {
  constructor() {
    super('Сумма платежа не совпадает с ожидаемой');
    this.name = 'PaymentAmountMismatchError';
  }
}

/** Платёж записи для маршрутов: статусы и ссылка на оплату, без персональных данных. */
export interface PaymentView {
  id: string;
  appointmentId: string;
  status: PaymentStatus;
  amountKopecks: number;
  yookassaPaymentId: string | null;
  confirmationUrl: string | null;
  appointmentStatus: BookingStatus;
}

/** Результат перехода: текущее состояние после вызова и что нужно сделать вызывающему. */
export interface PaymentTransition {
  paymentId: string;
  appointmentId: string;
  status: PaymentStatus;
  appointmentStatus: BookingStatus;
  /** Переход выполнен этим вызовом; `false` — повтор (no-op), состояние уже было таким. */
  changed: boolean;
  /** Оплата пришла после отмены записи: вызывающий обязан вернуть деньги через шлюз. */
  needsRefund: boolean;
}

/** Результат фиксации возврата: `refundId` нужен вызывающему для лога и трассировки. */
export interface RefundTransition extends PaymentTransition {
  refundId: string;
}

/** Результат отметки «возврат обязателен»: по нему видно, поставил ли флаг именно этот вызов. */
export interface RefundRequiredTransition {
  paymentId: string;
  appointmentId: string;
  status: PaymentStatus;
  /** Флаг поставлен этим вызовом; `false` — он уже стоял или статус не подходит под возврат. */
  changed: boolean;
}

/** Задание свиперу: по какому платежу вернуть деньги и сколько. Без персональных данных. */
export interface PendingRefund {
  paymentId: string;
  yookassaPaymentId: string;
  amountKopecks: number;
}

/**
 * Состояние платежа и записи — без персональных данных. Минимальная выборка для отмены,
 * возврата и статуса: почта и имя клиента не читаются.
 */
const paymentStateSelect = {
  id: true,
  appointmentId: true,
  status: true,
  amountKopecks: true,
  yookassaPaymentId: true,
  confirmationUrl: true,
  appointment: { select: { status: true } },
} as const;

/**
 * Та же выборка плюс снимок для письма-подтверждения. Читается только на пути успешной
 * оплаты: без письма персональные данные не нужны.
 */
const paymentSnapshotSelect = {
  ...paymentStateSelect,
  appointment: {
    select: {
      id: true,
      status: true,
      clientName: true,
      clientEmail: true,
      startsAt: true,
      endsAt: true,
      priceKopecks: true,
      durationMin: true,
      service: { select: { name: true } },
      master: { select: { fullName: true } },
    },
  },
} as const;

type PaymentStateRow = Prisma.PaymentGetPayload<{ select: typeof paymentStateSelect }>;
type PaymentSnapshotRow = Prisma.PaymentGetPayload<{ select: typeof paymentSnapshotSelect }>;

/** Минимальная выборка для флага возврата: без вложенной записи и персональных данных. */
const refundRequiredSelect = { id: true, appointmentId: true, status: true } as const;

function toView(row: PaymentStateRow): PaymentView {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    status: row.status,
    amountKopecks: row.amountKopecks,
    yookassaPaymentId: row.yookassaPaymentId,
    confirmationUrl: row.confirmationUrl,
    appointmentStatus: row.appointment.status,
  };
}

function toTransition(
  row: PaymentStateRow,
  options: { changed: boolean; needsRefund?: boolean },
): PaymentTransition {
  return {
    paymentId: row.id,
    appointmentId: row.appointmentId,
    status: row.status,
    appointmentStatus: row.appointment.status,
    changed: options.changed,
    needsRefund: options.needsRefund ?? false,
  };
}

/**
 * Строка подтверждения в outbox — только если её ещё нет.
 *
 * Повторный вебхук не должен поставить второе письмо, а созданное при записи подтверждение
 * (режим без оплаты) — дублироваться. Идемпотентность перехода уже гарантирована статусом
 * платежа, эта проверка защищает от двух строк на один визит. Без почты клиента письмо
 * поставить некуда — тогда строки просто нет.
 */
async function ensureBookingConfirmation(
  tx: Prisma.TransactionClient,
  appointment: PaymentSnapshotRow['appointment'],
): Promise<boolean> {
  const clientEmail = appointment.clientEmail?.trim() ?? '';
  if (clientEmail === '') return false;

  const existing = await tx.outboxMessage.findFirst({
    where: { appointmentId: appointment.id, type: BOOKING_CONFIRMATION_TYPE },
    select: { id: true },
  });
  if (existing !== null) return false;

  await tx.outboxMessage.create({
    data: {
      type: BOOKING_CONFIRMATION_TYPE,
      appointmentId: appointment.id,
      payload: buildBookingConfirmationPayload({
        clientName: appointment.clientName,
        clientEmail,
        serviceName: appointment.service.name,
        masterName: appointment.master.fullName,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        priceKopecks: appointment.priceKopecks,
        durationMin: appointment.durationMin,
      }),
    },
  });
  return true;
}

/**
 * Фактический статус записи в той же транзакции: снимок, прочитанный до `updateMany`, мог
 * устареть (запись отменили свипером или клиентом между чтением и условным `UPDATE`).
 * Снимок остаётся запасным значением — строки нет только теоретически (FK держит её на месте).
 */
async function actualAppointmentStatus(
  tx: Prisma.TransactionClient,
  payment: PaymentSnapshotRow,
): Promise<BookingStatus> {
  const current = await tx.appointment.findUnique({
    where: { id: payment.appointmentId },
    select: { status: true },
  });
  return current?.status ?? payment.appointment.status;
}

/**
 * `payment.succeeded`: платёж `succeeded`, запись `confirmed`, письмо-подтверждение в outbox.
 *
 * `null` — платежа с таким id нет (уведомление не про нас): вызывающий отвечает 200 и пишет
 * в лог id, чтобы не заставлять провайдера повторять уведомление 24 часа.
 *
 * Оплата после отмены записи (холд истёк, запись `cancelled`): запись не подтверждается,
 * возвращается `needsRefund: true` — деньги возвращает вызывающий, а платёж сначала
 * фиксируется как `succeeded`: это факт, который нельзя терять.
 *
 * Отмена может произойти и после чтения снимка: тогда условный `UPDATE` записи даёт `count === 0`,
 * и статус перечитывается в той же транзакции — `needsRefund` выставляется по факту, а не по снимку.
 */
export async function applyPaymentSucceeded(
  db: Db,
  paymentId: string,
  input: { amountKopecks: number },
): Promise<PaymentTransition | null> {
  return db.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      select: paymentSnapshotSelect,
    });
    if (payment === null) return null;

    // Терминальный статус: повтор уведомления не меняет ни платёж, ни запись.
    if (payment.status !== 'pending') return toTransition(payment, { changed: false });

    // Деньги приняты не по нашему расчёту — переход не выполняем (решение за вызывающим).
    if (input.amountKopecks !== payment.amountKopecks) throw new PaymentAmountMismatchError();

    // Претендуем на переход условным UPDATE: параллельный обработчик того же уведомления
    // увидит `count === 0` и вернёт состояние, не поставив второе письмо.
    const claimed = await tx.payment.updateMany({
      where: { id: paymentId, status: 'pending' },
      data: { status: 'succeeded' },
    });
    if (claimed.count === 0) {
      const current = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        select: paymentStateSelect,
      });
      return toTransition(current, { changed: false });
    }

    if (payment.appointment.status === 'cancelled') {
      return {
        paymentId: payment.id,
        appointmentId: payment.appointmentId,
        status: 'succeeded',
        appointmentStatus: 'cancelled',
        changed: true,
        needsRefund: true,
      };
    }

    // Подтверждаем только запись, которая ещё ждёт оплаты. Условие в WHERE — вместо проверки
    // до записи: если между чтением и обновлением запись отменили, `count === 0` и снимок
    // устарел — фактический статус перечитываем в той же транзакции, иначе возврат
    // по уже отменённой (свипером) записи не запустится.
    const confirmed = await tx.appointment.updateMany({
      where: { id: payment.appointmentId, status: 'pending' },
      // Дедлайн холда больше не нужен: свипер смотрит только `pending`.
      data: { status: 'confirmed', paymentDeadlineAt: null },
    });
    const appointmentStatus: BookingStatus =
      confirmed.count === 1 ? 'confirmed' : await actualAppointmentStatus(tx, payment);

    // Письмо-подтверждение — только для подтверждённой записи и только если его ещё нет.
    if (appointmentStatus === 'confirmed') {
      await ensureBookingConfirmation(tx, payment.appointment);
    }

    return {
      paymentId: payment.id,
      appointmentId: payment.appointmentId,
      status: 'succeeded',
      appointmentStatus,
      changed: true,
      // Оплата пришла по записи, которую уже отменили: подтвердить её нельзя —
      // деньги обязан вернуть вызывающий.
      needsRefund: appointmentStatus === 'cancelled',
    };
  });
}

/**
 * `payment.canceled`: платёж `canceled`, запись `cancelled` с причиной `payment_canceled`.
 *
 * Запись отменяется, только если она всё ещё ждёт (`pending`): подтверждённую или уже
 * отменённую не трогаем. Письмо-подтверждение не ставится — отменённый визит письма не требует
 * (в режиме оплаты оно ещё и не создавалось).
 */
export async function applyPaymentCanceled(
  db: Db,
  paymentId: string,
): Promise<PaymentTransition | null> {
  return db.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      select: paymentStateSelect,
    });
    if (payment === null) return null;

    if (payment.status !== 'pending') return toTransition(payment, { changed: false });

    const claimed = await tx.payment.updateMany({
      where: { id: paymentId, status: 'pending' },
      data: { status: 'canceled' },
    });
    if (claimed.count === 0) {
      const current = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        select: paymentStateSelect,
      });
      return toTransition(current, { changed: false });
    }

    const cancelled = await tx.appointment.updateMany({
      where: { id: payment.appointmentId, status: 'pending' },
      data: {
        status: 'cancelled',
        cancelReason: PAYMENT_CANCELED_REASON,
        paymentDeadlineAt: null,
      },
    });
    const appointmentStatus: BookingStatus =
      cancelled.count === 1 ? 'cancelled' : payment.appointment.status;

    return {
      paymentId: payment.id,
      appointmentId: payment.appointmentId,
      status: 'canceled',
      appointmentStatus,
      changed: true,
      needsRefund: false,
    };
  });
}

/**
 * Фиксация выполненного возврата: платёж `refunded` и снятый флаг `refund_required`.
 *
 * Вызывается после успешного `createRefund` в шлюзе. Идемпотентно: повтор с тем же
 * (или новым) `refundId` при уже `refunded` платеже — no-op.
 *
 * Флаг снимается в той же транзакции, что и статус: иначе свипер после успешного возврата
 * повторял бы его следующим тиком. В ветке «уже `refunded`» флага быть не может: он ставится
 * только платежу в `succeeded`/`canceled`, а снимается здесь же, поэтому повторный вызов
 * (идемпотентность) не перезаписывает ни `refund_id`, ни `refund_status`.
 *
 * `refundId` и терминальный статус `succeeded` пишутся тем же `UPDATE`, что и переход в `refunded`:
 * факт и статус последней попытки возврата остаются в БД (`payments.refund_id`,
 * `payments.refund_status`), а не только в логе.
 */
export async function markRefunded(
  db: Db,
  paymentId: string,
  refundId: string,
): Promise<RefundTransition | null> {
  return db.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      select: paymentStateSelect,
    });
    if (payment === null) return null;

    if (payment.status === 'refunded') {
      return { ...toTransition(payment, { changed: false }), refundId };
    }

    // Возврат возможен только по платежу, деньги по которому получены. `canceled` принимаем:
    // провайдер мог отменить платёж в момент возврата, но деньги у него уже были.
    const updated = await tx.payment.updateMany({
      where: { id: paymentId, status: { in: ['succeeded', 'canceled'] } },
      data: { status: 'refunded', refundRequired: false, refundId, refundStatus: 'succeeded' },
    });
    if (updated.count === 0) {
      const current = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
        select: paymentStateSelect,
      });
      return { ...toTransition(current, { changed: false }), refundId };
    }

    return {
      paymentId: payment.id,
      appointmentId: payment.appointmentId,
      status: 'refunded',
      appointmentStatus: payment.appointment.status,
      changed: true,
      needsRefund: false,
      refundId,
    };
  });
}

/**
 * Неуспешная попытка возврата: фактический статус провайдера и его id остаются в БД.
 *
 * Зачем: лог — не место для факта. `canceled` (провайдер отказал) и `pending` (деньги ещё в пути)
 * видит человек при разборе, а `unknown` (ответ не распознан) отличается от NULL («попыток
 * не было») только в схеме.
 *
 * Флаг `refund_required` не снимается и не ставится: снимает его только `markRefunded` вместе
 * с переходом в `refunded`. Условие `refund_required = true` в `WHERE` даёт guard от гонки:
 * уже возвращённый платёж (флаг снят) не получит несостоявшийся статус задним числом.
 *
 * Идемпотентность возврата не страдает: ключ `refund-<paymentId>` выводится из id платежа,
 * а не из сохранённого статуса, поэтому перезапись статуса — это прогресс того же возврата
 * (`pending` → `canceled` становится виден).
 *
 * `true` — строка обновлена, `false` — платёж уже `refunded` (или его нет).
 */
export async function recordRefundAttempt(
  db: Db,
  paymentId: string,
  refundId: string,
  refundStatus: Exclude<GatewayRefundStatus, 'succeeded'>,
): Promise<boolean> {
  const updated = await db.payment.updateMany({
    where: { id: paymentId, refundRequired: true },
    data: { refundId, refundStatus },
  });
  return updated.count === 1;
}

/**
 * Статус возврата в терминах клиента (issue #103).
 *
 * Служебные коды БД и провайдера наружу не отдаются: клиенту важно «деньги в пути»,
 * «вернулись», «возврат не удался». Соответствие:
 * - `status === 'refunded'` → `succeeded`: возврат зафиксирован, деньги у клиента;
 * - `refundRequired && refundStatus === 'canceled'` → `failed`: провайдер отказал, разбирать
 *   должен человек (клиенту — «позвоните в салон»); `unknown` и `pending` — всё ещё в пути,
 *   потому что обязанность вернуть деньги (флаг) не снята и повторит её свипер;
 * - `refundRequired` → `pending`: деньги должны вернуться, попытки ещё идут или не было;
 * - иначе `null`: возврата нет (запись не оплачена или платёж `pending`/`canceled` без флага).
 *
 * Функция чистая: её вызывает и DTO кабинета, поэтому логика статуса живёт в одном месте,
 * а не дублируется в сервисе и в тестах через разные коды.
 */
export function clientRefundStatus(
  payment: {
    status: PaymentStatus;
    refundRequired: boolean;
    refundStatus: GatewayRefundStatus | null;
  } | null,
): RefundClientStatus | null {
  if (payment === null) return null;
  if (payment.status === 'refunded') return 'succeeded';
  if (payment.refundRequired && payment.refundStatus === 'canceled') return 'failed';
  if (payment.refundRequired) return 'pending';
  return null;
}

/**
 * Обязательство вернуть деньги: `payments.refund_required = true`.
 *
 * Нужно, когда возврат в момент уведомления не удался (API ЮKassa недоступен): статус платежа
 * менять нельзя — деньги действительно получены, — а обязанность вернуть их нельзя терять.
 * Флаг переживает перезапуск и добивается свипером; повтор уведомления её не воспроизводит
 * (уже `succeeded`, `needsRefund` больше не приходит).
 *
 * Ставится только тому, у кого деньги были на руках: `succeeded` (оплата прошла) или
 * `canceled` (провайдер отменил, но возврат уже отправлялся). `pending` и `refunded` не трогаются:
 * у первого денег нет, второй уже возвращён.
 *
 * Идемпотентно: повтор не меняет состояние (`changed: false`). `null` — такого платежа нет.
 */
export async function markRefundRequired(
  db: Db,
  paymentId: string,
): Promise<RefundRequiredTransition | null> {
  return db.$transaction(async (tx) => {
    // Условия в WHERE, а не после чтения: флаг не встанет платежу, который успел уйти
    // в другой статус (например, возврат уже зафиксирован параллельным вызовом).
    const claimed = await tx.payment.updateManyAndReturn({
      where: { id: paymentId, status: { in: ['succeeded', 'canceled'] }, refundRequired: false },
      data: { refundRequired: true },
      select: refundRequiredSelect,
    });
    const row = claimed[0];
    if (row !== undefined) {
      return {
        paymentId: row.id,
        appointmentId: row.appointmentId,
        status: row.status,
        changed: true,
      };
    }

    // Повтор или неподходящий статус: отдаём фактическое состояние, флаг не трогаем.
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      select: refundRequiredSelect,
    });
    return payment === null
      ? null
      : {
          paymentId: payment.id,
          appointmentId: payment.appointmentId,
          status: payment.status,
          changed: false,
        };
  });
}

/**
 * Обязательство вернуть деньги по отменённой записи: `payments.refund_required = true`
 * в той же транзакции, что и перевод записи в `cancelled` (клиентская и салонная отмена).
 *
 * Условия стоят в самом `WHERE`, а не в чтении перед записью: флаг не встанет платежу,
 * который успел уйти в другой статус (возврат уже зафиксирован параллельным вызовом),
 * и не перезапишется у платежа, которому флаг уже поставили. Платёж у записи один
 * (unique `appointment_id`), поэтому `updateMany` — это один условный `UPDATE`.
 *
 * Ставится только `succeeded`: у `pending` денег ещё нет (опоздавшую оплату разберёт
 * обработчик уведомления своим `needsRefund`), `canceled` и `refunded` уже разобраны
 * уведомлением и свипером. Отсутствие платежа — не ошибка (режим без оплаты): строка
 * просто не находится.
 *
 * `true` — флаг поставлен этим вызовом, `false` — платить было нечего или он уже стоял.
 */
export async function markRefundRequiredByAppointment(
  tx: Prisma.TransactionClient,
  appointmentId: string,
): Promise<boolean> {
  const updated = await tx.payment.updateMany({
    where: { appointmentId, status: 'succeeded', refundRequired: false },
    data: { refundRequired: true },
  });
  return updated.count === 1;
}

/**
 * Платежи с обязательным возвратом — задание для свипера.
 *
 * Только служебные поля и без персональных данных: `yookassa_payment_id` нужен шлюзу,
 * `amount_kopecks` — сумма возврата. Платежи без id у провайдера пропускаются: возвращать
 * не по чему (деньги по такому платежу не могли уйти) — но и не теряются из виду: строка
 * остаётся с флагом и попадает в выборку после появления id.
 *
 * Старые — первыми: так ни один платёж не ждёт вечно, пока новые забирают лимит тика.
 */
export async function listPendingRefunds(
  db: Db,
  limit: number = PENDING_REFUNDS_LIMIT,
): Promise<PendingRefund[]> {
  const rows = await db.payment.findMany({
    where: { refundRequired: true, yookassaPaymentId: { not: null } },
    select: { id: true, yookassaPaymentId: true, amountKopecks: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  // `not: null` в фильтре не сужает тип поля: проверка нужна, чтобы не отдать `null` в шлюз.
  return rows.flatMap((row) =>
    row.yookassaPaymentId === null
      ? []
      : [
          {
            paymentId: row.id,
            yookassaPaymentId: row.yookassaPaymentId,
            amountKopecks: row.amountKopecks,
          },
        ],
  );
}

/**
 * Сколько строк отдаёт обзор возвратов по умолчанию. Обзор — для человека, а не поток:
 * больше полусотни одновременных разборов — уже авария, а не рабочий режим.
 */
export const REFUNDS_NEEDING_ATTENTION_LIMIT = 50;

/**
 * Строка обзора «возвраты, требующие внимания»: только id, статусы и копейки.
 *
 * `yookassa_payment_id` — id провайдера (не ПДн): без него ручной разбор в личном кабинете
 * ЮKassa невозможен. Ни телефона, ни почты, ни имени клиента здесь нет и не будет.
 */
export interface RefundNeedingAttention {
  paymentId: string;
  appointmentId: string;
  status: PaymentStatus;
  amountKopecks: number;
  refundRequired: boolean;
  refundId: string | null;
  refundStatus: GatewayRefundStatus | null;
  yookassaPaymentId: string | null;
  createdAt: Date;
}

/**
 * «Возвраты, требующие внимания» одним запросом: долг по флагу или отказ провайдера.
 *
 * Отбор — `refund_required = true` (возврат ещё не выполнен) ИЛИ `refund_status = 'canceled'`
 * (провайдер отказал, повторы могут длиться бесконечно, а разбирать надо руками). Старые —
 * первыми, как в свипере: никто не ждёт вечно, пока новые забирают лимит.
 *
 * Маршрута у обзора пока нет (админки и матрицы разрешений тоже) — это функция сервиса,
 * готовая к подключению. ПДн не читаются: только id платёжа/записи, статусы и копейки.
 */
export async function listRefundsNeedingAttention(
  db: Db,
  limit: number = REFUNDS_NEEDING_ATTENTION_LIMIT,
): Promise<RefundNeedingAttention[]> {
  const rows = await db.payment.findMany({
    where: { OR: [{ refundRequired: true }, { refundStatus: 'canceled' }] },
    select: {
      id: true,
      appointmentId: true,
      status: true,
      amountKopecks: true,
      refundRequired: true,
      refundId: true,
      refundStatus: true,
      yookassaPaymentId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  return rows.map((row) => ({
    paymentId: row.id,
    appointmentId: row.appointmentId,
    status: row.status,
    amountKopecks: row.amountKopecks,
    refundRequired: row.refundRequired,
    refundId: row.refundId,
    refundStatus: row.refundStatus,
    yookassaPaymentId: row.yookassaPaymentId,
    createdAt: row.createdAt,
  }));
}

/** Платёж записи для страницы статуса оплаты. `null` — платежа нет (оплата не создавалась). */
export async function findPaymentByAppointment(
  db: Db,
  appointmentId: string,
): Promise<PaymentView | null> {
  const payment = await db.payment.findUnique({
    where: { appointmentId },
    select: paymentStateSelect,
  });
  return payment === null ? null : toView(payment);
}
