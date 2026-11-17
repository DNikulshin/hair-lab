import type { BookingStatus } from '@hair-lab/contracts';

/**
 * День админки: календарные даты, подписи и человеческие причины отмены.
 *
 * Чистые функции без React и сети: их проверяют обычные unit-тесты. Часовой пояс салона
 * приходит аргументом (`Intl` с явным `timeZone`), поэтому результат не зависит от пояса
 * машины сотрудника. Арифметика дат — по календарю (`Date.UTC`), а не прибавлением суток
 * к моменту времени: переход на летнее/зимнее время не должен двигать день.
 *
 * ПДн здесь нет: только даты, статусы и машинные причины отмены из БД.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Префикс причины салонной отмены в `appointments.cancel_reason` (константа API). */
export const SALON_CANCEL_PREFIX = 'cancelled_by_salon: ';

/**
 * Календарная дата момента в часовом поясе салона (`YYYY-MM-DD`).
 * `Intl` с явным поясом: подпись «сегодня» не должна зависеть от часов машины.
 */
export function salonToday(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${value('year')}-${value('month')}-${value('day')}`;
}

/**
 * Календарная дата ± N дней. Арифметика по календарю в UTC: `2028-02-28` + 1 — это
 * `2028-02-29`, а не «плюс 24 часа» (в день перехода на летнее время сутки короче).
 * Некорректную дату не проверяем — её отсекает `calendarDateSchema` на границе.
 */
export function shiftDate(date: string, days: number): string {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

const dayLabelFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/**
 * Подпись дня для заголовка: «вторник, 17 ноября 2026».
 * Собираем из частей, а не через `format`: русская локаль добавляет к году «г.»,
 * а в заголовке экрана точка не нужна.
 */
export function formatDayLabel(date: string): string {
  const parts = dayLabelFormatter.formatToParts(new Date(`${date}T00:00:00Z`));

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${value('weekday')}, ${value('day')} ${value('month')} ${value('year')}`;
}

/** Подписи статусов записи для сотрудника. */
const STATUS_LABELS: Record<BookingStatus, string> = {
  pending: 'Ждёт подтверждения',
  confirmed: 'Подтверждена',
  cancelled: 'Отменена',
  completed: 'Завершена',
  no_show: 'Не пришёл',
};

/** Подпись статуса; неизвестный код не роняет рендер. */
export function adminStatusLabel(status: BookingStatus): string {
  return STATUS_LABELS[status] ?? 'Статус неизвестен';
}

/** Активная запись: с ней ещё можно что-то сделать (подтвердить, завершить, отменить). */
export function isActiveAdminStatus(status: BookingStatus): boolean {
  return status === 'pending' || status === 'confirmed';
}

/**
 * Служебные причины отмены: их ставит не человек, а API (оплата). Тексты объясняют
 * сотруднику, что произошло, без технических кодов.
 */
const CANCEL_REASON_LABELS: Record<string, string> = {
  cancelled_by_client: 'Отменена клиентом',
  payment_expired: 'Отменена: не оплачена вовремя',
  payment_canceled: 'Отменена: оплата отменена',
  payment_creation_failed: 'Отменена: не удалось создать оплату',
};

/**
 * Машинная причина отмены → подпись для сотрудника.
 *
 * `null` и `undefined` — отмены не было (пустая строка: показывать нечего). `undefined`
 * приходит от API прежней версии, который поля ещё не отдавал: причина неизвестна, но
 * подписи нет — то же поведение, что у `null`.
 * Причина салона приходит с префиксом и текстом, который ввёл сотрудник:
 * «Отменена салоном: <причина>». Неизвестный код — нейтральное «Отменена»: набор служебных
 * причин живёт в API, и его расширение не должно ломать уже установленный web.
 */
export function formatAdminCancelReason(cancelReason: string | null | undefined): string {
  if (cancelReason === null || cancelReason === undefined) return '';

  const value = cancelReason.trim();
  if (value === '') return '';

  if (value.startsWith(SALON_CANCEL_PREFIX)) {
    const reason = value.slice(SALON_CANCEL_PREFIX.length).trim();
    if (reason !== '') return `Отменена салоном: ${reason}`;
  }

  return CANCEL_REASON_LABELS[value] ?? 'Отменена';
}
