import type { BookingStatus, RefundClientStatus } from '@hair-lab/contracts';

/**
 * Подписи статусов записи для кабинета.
 *
 * Текст статуса — про то, что человеку важно знать: подтверждён ли визит и что
 * с ним произошло. Коды статусов из контракта в интерфейс не попадают.
 */

const STATUS_LABELS: Record<BookingStatus, string> = {
  pending: 'Ждёт подтверждения',
  confirmed: 'Подтверждена',
  cancelled: 'Отменена',
  completed: 'Завершена',
  no_show: 'Неявка',
};

/**
 * Подпись статуса; неизвестный код не роняет рендер.
 *
 * `awaitingPayment` уточняет только `pending`: при включённой оплате запись ждёт денег,
 * а не подтверждения салона. Поле в DTO аддитивное — старый API его не присылает,
 * и тогда остаётся прежняя нейтральная подпись.
 */
export function bookingStatusLabel(status: BookingStatus, awaitingPayment = false): string {
  if (status === 'pending' && awaitingPayment) return 'Ждёт оплаты';
  return STATUS_LABELS[status] ?? 'Статус неизвестен';
}

/** Активная запись: её ещё ждут — статус выделяем цветом. */
export function isActiveStatus(status: BookingStatus): boolean {
  return status === 'pending' || status === 'confirmed';
}

/**
 * Подписи возврата денег по отменённой оплаченной записи (#103).
 *
 * Служебные коды провайдера сюда не доходят: сервер отдаёт уже переведённый статус
 * (`pending`/`succeeded`/`failed`), а клиент его только называет. Срок тот же, что
 * в письме об отмене и на странице оплаты: до 3 рабочих дней.
 */
const REFUND_LABELS: Record<RefundClientStatus, string> = {
  pending: 'Возврат на карту — до 3 рабочих дней.',
  succeeded: 'Деньги за запись возвращены.',
  failed: 'Возврат не удался — позвоните в салон.',
};

/** Подпись статуса возврата; неизвестный код (новый статус от API) не роняет рендер. */
export function refundStatusLabel(status: RefundClientStatus): string {
  return REFUND_LABELS[status] ?? '';
}
