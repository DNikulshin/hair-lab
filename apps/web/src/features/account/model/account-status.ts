import type { BookingStatus } from '@hair-lab/contracts';

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
