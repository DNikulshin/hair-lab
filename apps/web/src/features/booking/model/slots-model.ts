import { slotsResponseSchema, type Slot } from '@hair-lab/contracts';

/**
 * Разбор ответа `GET /slots` и подготовка данных для формы записи.
 *
 * Чистые функции без React и без обращений к сети: их проверяют обычные unit-тесты.
 * Ответ API валидируется контрактом; невалидный payload — это «сервис недоступен»,
 * а не «свободного времени нет»: разницу видит пользователь.
 */

/** Плоский список слотов либо `null`, если ответ не соответствует контракту. */
export function parseSlotsPayload(payload: unknown): Slot[] | null {
  const parsed = slotsResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data.items : null;
}

/** Слоты одного мастера: в форме группа подписана его именем. */
export interface MasterSlots {
  masterId: string;
  slots: Slot[];
}

/**
 * Группировка слотов по мастерам. Порядок групп — порядок первого появления в ответе
 * (API сортирует по времени, затем по мастеру), внутри группы время уже отсортировано.
 */
export function groupSlotsByMaster(items: readonly Slot[]): MasterSlots[] {
  const groups = new Map<string, MasterSlots>();

  for (const slot of items) {
    let group = groups.get(slot.masterId);
    if (group === undefined) {
      group = { masterId: slot.masterId, slots: [] };
      groups.set(slot.masterId, group);
    }
    group.slots.push(slot);
  }

  return [...groups.values()];
}

/** Вариант даты в форме: значение для API и подпись для человека. */
export interface DateOption {
  /** Календарная дата в часовом поясе салона (`YYYY-MM-DD`). */
  date: string;
  label: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const dateLabelFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC',
  weekday: 'short',
  day: 'numeric',
  month: 'long',
});

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function timeFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = timeFormatters.get(timeZone);
  if (cached !== undefined) return cached;

  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  timeFormatters.set(timeZone, formatter);
  return formatter;
}

/**
 * Календарная дата момента в часовом поясе салона.
 * `Intl` с явным поясом: результат не зависит от пояса машины пользователя.
 */
function salonCalendarDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** Календарная дата + N дней. Арифметика по календарю, без часовых поясов и переходов. */
function addDays(date: string, days: number): string {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Подпись даты: «Пн, 4 марта». Считается по календарной дате, поэтому `UTC` в форматтере. */
function formatDateLabel(date: string): string {
  const text = dateLabelFormatter.format(new Date(`${date}T00:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Даты для выбора, начиная с сегодняшнего дня в часовом поясе салона.
 * `days` ограничивается горизонтом записи API (30 дней), в форме берём меньше.
 */
export function buildDateOptions(now: Date, timeZone: string, days: number): DateOption[] {
  if (!Number.isFinite(days) || days < 1) return [];

  const today = salonCalendarDate(now, timeZone);
  return Array.from({ length: Math.floor(days) }, (_, index) => {
    const date = addDays(today, index);
    return { date, label: formatDateLabel(date) };
  });
}

/** Время начала слота в поясе салона: `09:00`. Некорректная дата — пустая строка. */
export function formatSlotTime(iso: string, timeZone: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';
  return timeFormatter(timeZone).format(instant);
}

/** Дата и время для экрана успеха: «Пн, 4 марта, 09:00». */
export function formatSlotDateTime(iso: string, timeZone: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';

  const time = timeFormatter(timeZone).format(instant);
  return `${formatDateLabel(salonCalendarDate(instant, timeZone))}, ${time}`;
}
