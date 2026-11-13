import type { Booking, BookingStatus, CreateBooking } from '@hair-lab/contracts';
import { env } from '../../shared/config/env';
import { sqlStateOf, type Db } from '../../shared/db';
import { isSlotBookable, loadSchedules, salonDateOf } from './slots.service';

/**
 * Создание записи на услугу.
 *
 * Идемпотентность: клиент присылает `idempotencyKey`, повтор запроса возвращает ту же запись.
 * Непересечение слотов одного мастера держит EXCLUDE-констрейнт в БД (`23P01`), поэтому
 * одновременные запросы на один слот не создают дубль — проигравший получает 409.
 * Телефоны и почта клиента наружу не отдаются и в логи не пишутся.
 */

const MINUTE_MS = 60_000;
const CURRENCY = 'RUB' as const;

/** Выбранное время занято, нерабочее или вне горизонта записи: ответ 409 `slot_unavailable`. */
export class SlotUnavailableError extends Error {
  constructor() {
    super('Выбранное время недоступно');
    this.name = 'SlotUnavailableError';
  }
}

/** Тот же `idempotencyKey`, но другое содержимое запроса: ответ 409 `conflict`. */
export class IdempotencyConflictError extends Error {
  readonly statusCode = 409;

  constructor() {
    super('Ключ идемпотентности уже использован для другого запроса');
    this.name = 'IdempotencyConflictError';
  }
}

/** Запись на несуществующую или отключённую услугу: ответ 404 `not_found`. */
export class ServiceNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super('Услуга не найдена');
    this.name = 'ServiceNotFoundError';
  }
}

/**
 * Мастер не найден, отключён или не оказывает выбранную услугу: ответ 404 `not_found`.
 * Одна ошибка на все три случая: наличие мастера и его связи с услугой не раскрываем,
 * а `GET /slots` такого мастера и так не предлагает.
 */
export class MasterNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super('Мастер не найден');
    this.name = 'MasterNotFoundError';
  }
}

/** Строка записи, достаточная для DTO (без контактов клиента). */
interface AppointmentRow {
  id: string;
  masterId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  status: BookingStatus;
  priceKopecks: number;
  durationMin: number;
  clientName: string;
}

export interface CreateBookingResult {
  /** 201 — запись создана, 200 — повтор запроса с тем же ключом идемпотентности. */
  status: 200 | 201;
  booking: Booking;
}

/** Маппинг строки БД в DTO: копейки → money, время → ISO, без телефона и почты. */
function toBookingDto(row: AppointmentRow): Booking {
  return {
    id: row.id,
    masterId: row.masterId,
    serviceId: row.serviceId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    price: { amountMinor: row.priceKopecks, currency: CURRENCY },
    durationMin: row.durationMin,
    clientName: row.clientName,
  };
}

/**
 * Тот же ли это запрос. Сравниваем только мастера, услугу и начало записи:
 * повтор с исправленными контактами клиента считается тем же запросом.
 */
function isSameRequest(row: AppointmentRow, dto: CreateBooking): boolean {
  return (
    row.masterId === dto.masterId &&
    row.serviceId === dto.serviceId &&
    row.startsAt.getTime() === new Date(dto.startsAt).getTime()
  );
}

/** Повтор ключа: либо та же запись (200), либо конфликт содержимого (409). */
function reuseOrConflict(row: AppointmentRow, dto: CreateBooking): CreateBookingResult {
  if (!isSameRequest(row, dto)) throw new IdempotencyConflictError();
  return { status: 200, booking: toBookingDto(row) };
}

/**
 * `POST /bookings`: проверка услуги и мастера, проверка доступности, создание записи,
 * снимки цены и длительности услуги. Неактивная услуга и мастер, который её не оказывает
 * (в том числе неизвестный или отключённый), отсекаются до загрузки расписания — 404.
 * Доступность проверяется той же логикой, что и `GET /slots`, но окончательную гарантию
 * от гонки даёт EXCLUDE-констрейнт (см. обработку `23P01`).
 */
export async function createBooking(db: Db, dto: CreateBooking): Promise<CreateBookingResult> {
  const tz = env.SALON_TIMEZONE;

  const existing = await db.appointment.findUnique({
    where: { idempotencyKey: dto.idempotencyKey },
  });
  if (existing !== null) return reuseOrConflict(existing, dto);

  const service = await db.service.findFirst({
    where: { id: dto.serviceId, isActive: true },
    select: { id: true, durationMin: true, priceKopecks: true },
  });
  if (service === null) throw new ServiceNotFoundError();

  // Мастер, его активность и связь с услугой — одним запросом: без N+1 и без FK-нарушения
  // на `appointment.master_id`. Неизвестный, отключённый мастер и мастер без услуги
  // дают одинаковый 404: `GET /slots` таких мастеров не предлагает.
  const master = await db.master.findFirst({
    where: { id: dto.masterId, isActive: true, services: { some: { serviceId: service.id } } },
    select: { id: true },
  });
  if (master === null) throw new MasterNotFoundError();

  const startsAt = new Date(dto.startsAt);
  const endsAt = new Date(startsAt.getTime() + service.durationMin * MINUTE_MS);
  const date = salonDateOf(startsAt, tz);

  const schedules = await loadSchedules(db, [dto.masterId], date, tz);
  const schedule = schedules.get(dto.masterId) ?? {
    workingHours: [],
    exceptions: [],
    appointments: [],
  };

  if (!isSlotBookable({ ...schedule, date, tz, startsAt, endsAt })) {
    throw new SlotUnavailableError();
  }

  try {
    const created = await db.appointment.create({
      data: {
        masterId: dto.masterId,
        serviceId: service.id,
        clientName: dto.clientName,
        clientPhone: dto.clientPhone,
        ...(dto.clientEmail === undefined ? {} : { clientEmail: dto.clientEmail }),
        startsAt,
        endsAt,
        priceKopecks: service.priceKopecks,
        durationMin: service.durationMin,
        idempotencyKey: dto.idempotencyKey,
      },
    });
    return { status: 201, booking: toBookingDto(created) };
  } catch (error) {
    const sqlState = sqlStateOf(error);
    // 23P01 — слот занял параллельный запрос, 23505 — уникальность idempotency_key.
    // В обоих случаях повторяем чтение по ключу: если запись есть, повтор безопасен.
    if (sqlState !== '23P01' && sqlState !== '23505') throw error;

    const repeated = await db.appointment.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (repeated !== null) return reuseOrConflict(repeated, dto);
    throw new SlotUnavailableError();
  }
}
