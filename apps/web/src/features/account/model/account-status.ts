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

/** Подпись статуса; неизвестный код не роняет рендер. */
export function bookingStatusLabel(status: BookingStatus): string {
  return STATUS_LABELS[status] ?? 'Статус неизвестен';
}

/** Активная запись: её ещё ждут — статус выделяем цветом. */
export function isActiveStatus(status: BookingStatus): boolean {
  return status === 'pending' || status === 'confirmed';
}
