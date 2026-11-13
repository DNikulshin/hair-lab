import type { Slot, SlotsQuery, SlotsResponse } from '@hair-lab/contracts';
import { env } from '../../shared/config/env';
import type { Db } from '../../shared/db';

/**
 * Свободные слоты мастера: чистая генерация сетки по расписанию и чтение расписания из БД.
 *
 * Рабочие часы хранятся как «минуты от полуночи» в часовом поясе салона, исключения и записи —
 * как абсолютные интервалы в UTC. Поэтому день расписания переводится в абсолютный UTC-интервал
 * через `Intl` (Temporal в Node 22 нет): переход на летнее/зимнее время учитывается, а
 * генерация не завязана на часовой пояс сервера.
 */

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;
const DAY_MS = DAY_MINUTES * MINUTE_MS;

/** Политика салона: шаг сетки, буфер до начала записи и горизонт онлайн-записи. */
export const SLOT_STEP_MIN = 15;
export const BOOKING_BUFFER_MIN = 30;
export const BOOKING_HORIZON_DAYS = 30;

/** Интервал рабочих часов: день недели (0 — воскресенье) и минуты от полуночи в TZ салона. */
export interface WorkingHoursRow {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

/** Абсолютный интервал UTC: исключение расписания или активная запись мастера. */
export interface BusyInterval {
  startsAt: Date;
  endsAt: Date;
}

/** Расписание одного мастера на конкретный день. */
export interface MasterSchedule {
  workingHours: WorkingHoursRow[];
  exceptions: BusyInterval[];
  appointments: BusyInterval[];
}

/** Свободный слот как интервал UTC; в DTO превращается в ISO-строку. */
export interface SlotRange {
  startsAt: Date;
  endsAt: Date;
}

/** Абсолютные границы календарного дня в TZ салона (полуоткрытый интервал). */
export interface DayWindow {
  startsAt: Date;
  endsAt: Date;
}

interface CalendarDateParts {
  year: number;
  month: number;
  day: number;
}

/** Разбор `YYYY-MM-DD`: формат и существование даты проверяет схема контракта. */
function parseCalendarDate(date: string): CalendarDateParts {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  return { year, month, day };
}

function isExistingCalendarDate({ year, month, day }: CalendarDateParts): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** Смещение пояса в минутах в конкретный момент: локальное время минус UTC. */
function offsetMinutesAt(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((item) => item.type === type);
    return part === undefined ? 0 : Number(part.value);
  };

  const asUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );

  return Math.round((asUtc - instant.getTime()) / MINUTE_MS);
}

/**
 * Настенное время в TZ салона → момент времени UTC.
 * Смещение считается дважды: второй раз — по уже найденному моменту, иначе на границе перехода
 * на летнее/зимнее время получается сдвиг на час. Для несуществующего локального времени
 * (час, который пропускают при переходе весной) возвращается ближайший существующий момент.
 */
function salonWallTimeToInstant(
  { year, month, day }: CalendarDateParts,
  minutesFromMidnight: number,
  tz: string,
): Date {
  const asUtc = Date.UTC(year, month - 1, day) + minutesFromMidnight * MINUTE_MS;
  const firstOffset = offsetMinutesAt(new Date(asUtc), tz);
  const candidate = new Date(asUtc - firstOffset * MINUTE_MS);
  const secondOffset = offsetMinutesAt(candidate, tz);
  return secondOffset === firstOffset ? candidate : new Date(asUtc - secondOffset * MINUTE_MS);
}

/** День недели календарной даты (0 — воскресенье): свойство даты, а не момента времени. */
export function dayOfWeekOf(date: string): number {
  const { year, month, day } = parseCalendarDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Календарная дата (`YYYY-MM-DD`) момента времени в TZ салона. */
export function salonDateOf(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? '';

  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** Границы календарного дня в TZ салона: `[начало дня, начало следующего дня)` в UTC. */
export function salonDayWindow(date: string, tz: string): DayWindow {
  const parts = parseCalendarDate(date);
  const nextDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return {
    startsAt: salonWallTimeToInstant(parts, 0, tz),
    endsAt: salonWallTimeToInstant(
      {
        year: nextDay.getUTCFullYear(),
        month: nextDay.getUTCMonth() + 1,
        day: nextDay.getUTCDate(),
      },
      0,
      tz,
    ),
  };
}

function overlaps(startsAt: number, endsAt: number, busy: BusyInterval): boolean {
  return startsAt < busy.endsAt.getTime() && endsAt > busy.startsAt.getTime();
}

/** Общая часть правил доступности: интервал и расписание дня. */
interface AvailabilityInput extends MasterSchedule {
  date: string;
  tz: string;
  startsAt: Date;
  endsAt: Date;
  now?: Date;
  bufferMin?: number;
  horizonDays?: number;
}

/**
 * Проверяет, можно ли поставить запись на конкретный интервал.
 *
 * Интервал доступен, если он целиком помещается в один рабочий интервал дня,
 * не пересекается с исключениями расписания и активными записями мастера,
 * начинается не раньше `now + буфер` и попадает в горизонт записи.
 */
export function isSlotBookable(input: AvailabilityInput): boolean {
  const {
    date,
    tz,
    startsAt,
    endsAt,
    workingHours,
    exceptions = [],
    appointments = [],
    now = new Date(),
    bufferMin = BOOKING_BUFFER_MIN,
    horizonDays = BOOKING_HORIZON_DAYS,
  } = input;

  const start = startsAt.getTime();
  const end = endsAt.getTime();
  if (end <= start) return false;
  if (start < now.getTime() + bufferMin * MINUTE_MS) return false;
  if (start > now.getTime() + horizonDays * DAY_MS) return false;

  const dayOfWeek = dayOfWeekOf(date);
  const parts = parseCalendarDate(date);

  const fitsWorkingHours = workingHours.some((hours) => {
    if (hours.dayOfWeek !== dayOfWeek) return false;
    if (hours.startMinute < 0 || hours.endMinute > DAY_MINUTES) return false;
    if (hours.endMinute <= hours.startMinute) return false;
    const intervalStart = salonWallTimeToInstant(parts, hours.startMinute, tz).getTime();
    const intervalEnd = salonWallTimeToInstant(parts, hours.endMinute, tz).getTime();
    return start >= intervalStart && end <= intervalEnd;
  });

  if (!fitsWorkingHours) return false;
  if (exceptions.some((busy) => overlaps(start, end, busy))) return false;
  if (appointments.some((busy) => overlaps(start, end, busy))) return false;

  return true;
}

export interface BuildSlotsInput extends MasterSchedule {
  /** Календарная дата в TZ салона (`YYYY-MM-DD`). */
  date: string;
  tz: string;
  serviceDurationMin: number;
  now?: Date;
  stepMin?: number;
  bufferMin?: number;
  horizonDays?: number;
}

/**
 * Свободные слоты на календарный день: сетка с шагом `stepMin` внутри рабочих интервалов.
 * Слот попадает в ответ, только если приём целиком помещается в рабочий интервал и проходит
 * общие правила доступности (`isSlotBookable`). Функция чистая: БД и `Date.now()` не читает.
 */
export function buildSlots(input: BuildSlotsInput): SlotRange[] {
  const {
    date,
    tz,
    serviceDurationMin,
    workingHours,
    stepMin = SLOT_STEP_MIN,
    now = new Date(),
    bufferMin = BOOKING_BUFFER_MIN,
    horizonDays = BOOKING_HORIZON_DAYS,
  } = input;

  if (serviceDurationMin <= 0 || stepMin <= 0) return [];

  const parts = parseCalendarDate(date);
  if (!isExistingCalendarDate(parts)) return [];

  const dayOfWeek = dayOfWeekOf(date);
  const durationMs = serviceDurationMin * MINUTE_MS;
  const slots: SlotRange[] = [];
  const seen = new Set<number>();

  for (const hours of workingHours) {
    if (hours.dayOfWeek !== dayOfWeek) continue;
    if (hours.startMinute < 0 || hours.endMinute > DAY_MINUTES) continue;
    if (hours.endMinute <= hours.startMinute) continue;

    const intervalStart = salonWallTimeToInstant(parts, hours.startMinute, tz);
    const intervalEnd = salonWallTimeToInstant(parts, hours.endMinute, tz);

    for (let offset = 0; ; offset += stepMin) {
      const startsAt = new Date(intervalStart.getTime() + offset * MINUTE_MS);
      const endsAt = new Date(startsAt.getTime() + durationMs);
      // Приём должен целиком помещаться в конец смены: дальше сдвиг только увеличивает конец.
      if (endsAt.getTime() > intervalEnd.getTime()) break;
      if (seen.has(startsAt.getTime())) continue;
      if (!isSlotBookable({ ...input, startsAt, endsAt, now, bufferMin, horizonDays })) continue;

      seen.add(startsAt.getTime());
      slots.push({ startsAt, endsAt });
    }
  }

  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

const EMPTY_SCHEDULE: MasterSchedule = { workingHours: [], exceptions: [], appointments: [] };

/**
 * Расписание нескольких мастеров на календарный день, разложенное по мастеру.
 * Запросов фиксированное число (без N+1): рабочие часы, исключения и активные записи.
 */
export async function loadSchedules(
  db: Db,
  masterIds: readonly string[],
  date: string,
  tz: string,
): Promise<Map<string, MasterSchedule>> {
  const schedules = new Map<string, MasterSchedule>(
    masterIds.map((masterId) => [masterId, { workingHours: [], exceptions: [], appointments: [] }]),
  );
  if (masterIds.length === 0) return schedules;

  const day = salonDayWindow(date, tz);
  const [workingHours, exceptions, appointments] = await Promise.all([
    db.masterWorkingHours.findMany({
      where: { masterId: { in: [...masterIds] }, dayOfWeek: dayOfWeekOf(date) },
      select: { masterId: true, dayOfWeek: true, startMinute: true, endMinute: true },
    }),
    db.scheduleException.findMany({
      where: {
        masterId: { in: [...masterIds] },
        startsAt: { lt: day.endsAt },
        endsAt: { gt: day.startsAt },
      },
      select: { masterId: true, startsAt: true, endsAt: true },
    }),
    db.appointment.findMany({
      where: {
        masterId: { in: [...masterIds] },
        status: { not: 'cancelled' },
        startsAt: { lt: day.endsAt },
        endsAt: { gt: day.startsAt },
      },
      select: { masterId: true, startsAt: true, endsAt: true },
    }),
  ]);

  for (const row of workingHours) {
    schedules.get(row.masterId)?.workingHours.push({
      dayOfWeek: row.dayOfWeek,
      startMinute: row.startMinute,
      endMinute: row.endMinute,
    });
  }
  for (const row of exceptions) {
    schedules.get(row.masterId)?.exceptions.push({ startsAt: row.startsAt, endsAt: row.endsAt });
  }
  for (const row of appointments) {
    schedules.get(row.masterId)?.appointments.push({ startsAt: row.startsAt, endsAt: row.endsAt });
  }

  return schedules;
}

/**
 * `GET /slots`: только свободные слоты активных мастеров, оказывающих услугу.
 * Неизвестная или отключённая услуга даёт пустой список: наличие услуги не раскрываем.
 */
export async function listSlots(db: Db, query: SlotsQuery): Promise<SlotsResponse> {
  const tz = env.SALON_TIMEZONE;

  const service = await db.service.findFirst({
    where: { id: query.serviceId, isActive: true },
    select: { id: true, durationMin: true },
  });
  if (service === null) return { items: [] };

  const masters = await db.master.findMany({
    where: {
      isActive: true,
      ...(query.masterId === undefined ? {} : { id: query.masterId }),
      services: { some: { serviceId: service.id } },
    },
    select: { id: true },
    orderBy: { fullName: 'asc' },
  });
  if (masters.length === 0) return { items: [] };

  const masterIds = masters.map((master) => master.id);
  const schedules = await loadSchedules(db, masterIds, query.date, tz);

  const items: Slot[] = [];
  for (const masterId of masterIds) {
    const schedule = schedules.get(masterId) ?? EMPTY_SCHEDULE;
    const slots = buildSlots({
      ...schedule,
      date: query.date,
      tz,
      serviceDurationMin: service.durationMin,
    });
    for (const slot of slots) {
      items.push({
        masterId,
        startsAt: slot.startsAt.toISOString(),
        endsAt: slot.endsAt.toISOString(),
      });
    }
  }

  items.sort(
    (a, b) => a.startsAt.localeCompare(b.startsAt) || a.masterId.localeCompare(b.masterId),
  );

  return { items };
}
