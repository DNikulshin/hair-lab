import type { BookingStatus, CreateBooking } from '@hair-lab/contracts';
import { describe, expect, it, vi } from 'vitest';
import { env } from '../../shared/config/env';
import type { Db } from '../../shared/db';
import {
  createBooking,
  IdempotencyConflictError,
  isWriteConflict,
  MAX_WRITE_CONFLICT_ATTEMPTS,
  SlotUnavailableError,
} from './bookings.service';
import { dayOfWeekOf, salonDateOf } from './slots.service';

/**
 * Unit-тесты `createBooking` без PostgreSQL: стаб `Db` отвечает на те вызовы, которые
 * делает сервис, и позволяет подменить ошибку попытки записи.
 *
 * Повтор при транзиентном конфликте проверяется именно здесь: настоящий deadlock
 * (`40P01`) воспроизводится недетерминированно и в unit-тесте недостижим, а
 * интеграционный тест гонки двух запросов (test/bookings-api.int.test.ts) проверяет
 * внешний контракт 201/409.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const MASTER_ID = '00000000-0000-4000-8000-000000000001';
const SERVICE_ID = '00000000-0000-4000-8000-000000000002';
const APPOINTMENT_ID = '00000000-0000-4000-8000-000000000003';
/** Другая услуга: тело запроса, которое не совпадает с сохранённой записью. */
const OTHER_SERVICE_ID = '00000000-0000-4000-8000-000000000004';
const IDEMPOTENCY_KEY = 'unit-test-idempotency-key';

/** Вымышленные контакты: не настоящие ПДн. */
const CLIENT_NAME = 'Тестовая Клиентка';
const CLIENT_PHONE = '+70000000000';

/** Начало слота: через N дней в 12:00 по времени салона (не зависит от пояса машины). */
function salonNoon(daysAhead: number, tz: string): Date {
  const instant = new Date(Date.now() + daysAhead * DAY_MS);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const sinceLocalMidnight =
    ((value('hour') * 60 + value('minute')) * 60 + value('second')) * 1000 +
    instant.getMilliseconds();
  return new Date(instant.getTime() - sinceLocalMidnight + 12 * 60 * MINUTE_MS);
}

const startsAt = salonNoon(3, env.SALON_TIMEZONE);
const endsAt = new Date(startsAt.getTime() + 60 * MINUTE_MS);

/** Строка записи, которую вернул бы `appointment.create`. */
const appointmentRow = {
  id: APPOINTMENT_ID,
  masterId: MASTER_ID,
  serviceId: SERVICE_ID,
  startsAt,
  endsAt,
  status: 'pending' as BookingStatus,
  priceKopecks: 500_000,
  durationMin: 60,
  clientName: CLIENT_NAME,
  clientPhone: CLIENT_PHONE,
};

const dto: CreateBooking = {
  masterId: MASTER_ID,
  serviceId: SERVICE_ID,
  startsAt: startsAt.toISOString(),
  clientName: CLIENT_NAME,
  clientPhone: CLIENT_PHONE,
  idempotencyKey: IDEMPOTENCY_KEY,
};

/**
 * Ошибка записи в том виде, в каком её отдаёт Prisma с драйвер-адаптером `pg`:
 * код Prisma в `code`, SQLSTATE — в `meta.driverAdapterError.cause.originalCode`.
 */
function writeConflictError(): Error {
  return Object.assign(new Error('deadlock detected'), {
    code: 'P2034',
    meta: { driverAdapterError: { cause: { originalCode: '40P01' } } },
  });
}

/**
 * Настройки стаба: позволяют воспроизвести повтор клиента, чья первая попытка уже
 * зафиксировала запись, и занятый слот.
 */
interface DbStubOptions {
  /**
   * Ответы чтения по `idempotencyKey` по порядку вызовов (`null` — записи нет).
   * Последний элемент повторяется для всех дальнейших вызовов, по умолчанию — всегда `null`.
   */
  findUniqueResults?: readonly (typeof appointmentRow | null)[];
  /** Активные записи мастера на этот день: так выбранный слот становится занятым. */
  busy?: readonly { masterId: string; startsAt: Date; endsAt: Date }[];
  /**
   * Показывать `busy` только со второй попытки записи: воспроизводит сценарий, где слот
   * занял параллельный запрос, а мы успели получить транзиентный конфликт записи.
   */
  busyFromRetry?: boolean;
}

/**
 * Стаб `Db`: услуга и мастер находятся, расписание — рабочий день целиком,
 * аппоинтментов нет. `transactionFailures` задаёт ошибку каждой попытки записи
 * (`null` — попытка проходит успешно).
 */
function createDbStub(
  transactionFailures: readonly (unknown | null)[],
  options: DbStubOptions = {},
) {
  const { findUniqueResults = [null], busy = [], busyFromRetry = false } = options;
  const date = salonDateOf(startsAt, env.SALON_TIMEZONE);
  const row = appointmentRow;
  let attemptIndex = 0;
  let findUniqueCalls = 0;

  const findUnique = vi.fn(async () => {
    const index = Math.min(findUniqueCalls, findUniqueResults.length - 1);
    findUniqueCalls += 1;
    return findUniqueResults[index] ?? null;
  });

  const transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
    const failure = transactionFailures[attemptIndex] ?? null;
    attemptIndex += 1;
    if (failure !== null) throw failure;
    return run({
      appointment: { create: vi.fn(async () => row) },
      outboxMessage: { create: vi.fn(async () => ({ id: row.id })) },
    });
  });

  const stub = {
    appointment: {
      findUnique,
      findMany: vi.fn(async () => (busyFromRetry && attemptIndex === 0 ? [] : [...busy])),
    },
    service: {
      findFirst: vi.fn(async () => ({
        id: SERVICE_ID,
        name: 'Стрижка',
        durationMin: row.durationMin,
        priceKopecks: row.priceKopecks,
      })),
    },
    master: {
      findFirst: vi.fn(async () => ({ id: MASTER_ID, fullName: 'Тестовый Мастер' })),
    },
    masterWorkingHours: {
      // Рабочий день целиком: слот в 12:00 попадает в него при любом поясе салона.
      findMany: vi.fn(async () => [
        { masterId: MASTER_ID, dayOfWeek: dayOfWeekOf(date), startMinute: 0, endMinute: 1440 },
      ]),
    },
    scheduleException: { findMany: vi.fn(async () => []) },
    $transaction: transaction,
  };

  return { db: stub as unknown as Db, stub };
}

describe('isWriteConflict', () => {
  it('P2034 в поле code — транзиентный конфликт', () => {
    expect(isWriteConflict({ code: 'P2034' })).toBe(true);
  });

  it('SQLSTATE 40001 и 40P01 из драйвер-адаптера (originalCode) — транзиентный конфликт', () => {
    expect(
      isWriteConflict({ meta: { driverAdapterError: { cause: { originalCode: '40001' } } } }),
    ).toBe(true);
    expect(
      isWriteConflict({ meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } }),
    ).toBe(true);
  });

  it('SQLSTATE в cause.code (fallback sqlStateOf) тоже распознаётся', () => {
    expect(isWriteConflict({ meta: { driverAdapterError: { cause: { code: '40001' } } } })).toBe(
      true,
    );
  });

  it('ошибка Prisma P2034 вместе с SQLSTATE deadlock — транзиентный конфликт', () => {
    expect(isWriteConflict(writeConflictError())).toBe(true);
  });

  it('нарушения констрейнтов и обычные ошибки не ретраибельны', () => {
    expect(
      isWriteConflict({ meta: { driverAdapterError: { cause: { originalCode: '23P01' } } } }),
    ).toBe(false);
    expect(
      isWriteConflict({ meta: { driverAdapterError: { cause: { originalCode: '23505' } } } }),
    ).toBe(false);
    expect(isWriteConflict(new Error('boom'))).toBe(false);
    expect(isWriteConflict(undefined)).toBe(false);
    expect(isWriteConflict(null)).toBe(false);
    expect(isWriteConflict('P2034')).toBe(false);
  });
});

describe('createBooking: транзиентный конфликт записи', () => {
  it('P2034 на первой попытке: вторая попытка создаёт запись с перечитыванием расписания', async () => {
    const { db, stub } = createDbStub([writeConflictError(), null]);

    const result = await createBooking(db, dto);

    expect(result.status).toBe(201);
    expect(result.booking.id).toBe(APPOINTMENT_ID);
    expect(stub.$transaction).toHaveBeenCalledTimes(MAX_WRITE_CONFLICT_ATTEMPTS);
    // Повтор идёт с начала попытки: расписание (и значит проверка доступности) читается заново.
    expect(stub.masterWorkingHours.findMany).toHaveBeenCalledTimes(MAX_WRITE_CONFLICT_ATTEMPTS);
    expect(stub.appointment.findMany).toHaveBeenCalledTimes(MAX_WRITE_CONFLICT_ATTEMPTS);
  });

  it('конфликт на всех попытках без записи по ключу — 409 slot_unavailable, а не 500', async () => {
    const { db, stub } = createDbStub([writeConflictError(), writeConflictError()]);

    await expect(createBooking(db, dto)).rejects.toBeInstanceOf(SlotUnavailableError);
    expect(stub.$transaction).toHaveBeenCalledTimes(MAX_WRITE_CONFLICT_ATTEMPTS);
    // Чтение по idempotencyKey: начальная проверка и разбор проигранной гонки.
    expect(stub.appointment.findUnique).toHaveBeenCalledTimes(2);
  });

  it('нетранзиентная ошибка не повторяется и выходит наружу', async () => {
    const failure = new Error('boom');
    const { db, stub } = createDbStub([failure]);

    await expect(createBooking(db, dto)).rejects.toBe(failure);
    expect(stub.$transaction).toHaveBeenCalledTimes(1);
    expect(stub.masterWorkingHours.findMany).toHaveBeenCalledTimes(1);
  });
});

/**
 * Сетевой ретрай клиента: первая попытка запроса уже зафиксировала запись, но ответ до клиента
 * не дошёл (или запрос B с тем же ключом проиграл гонку и ушёл на повтор). На повторе слот
 * занят — уже нашей же записью, — поэтому ключ идемпотентности проверяется до 409
 * `slot_unavailable`: клиент получает ту же запись (200) или 409 `conflict`, если тело другое.
 */
describe('createBooking: занятый слот и ключ идемпотентности', () => {
  /** Слот занят активной записью мастера — как после победы параллельного запроса. */
  const busy = [{ masterId: MASTER_ID, startsAt, endsAt }];

  it('слот занят, но запись по ключу есть — 200 с существующей записью', async () => {
    const { db, stub } = createDbStub([null], {
      // Первое чтение — записи ещё нет; второе — параллельный запрос с тем же ключом зафиксировался.
      findUniqueResults: [null, appointmentRow],
      busy,
    });

    const result = await createBooking(db, dto);

    expect(result.status).toBe(200);
    expect(result.booking.id).toBe(APPOINTMENT_ID);
    // Новая запись не создаётся: транзакция записи не начиналась.
    expect(stub.$transaction).not.toHaveBeenCalled();
    expect(stub.appointment.findUnique).toHaveBeenCalledTimes(2);
  });

  it('слот занят, запись по ключу есть, но тело другое — 409 conflict', async () => {
    const { db, stub } = createDbStub([null], {
      findUniqueResults: [null, appointmentRow],
      busy,
    });

    await expect(createBooking(db, { ...dto, serviceId: OTHER_SERVICE_ID })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(stub.$transaction).not.toHaveBeenCalled();
  });

  it('слот занят, ключ новый — по-прежнему 409 slot_unavailable', async () => {
    const { db, stub } = createDbStub([null], { busy });

    await expect(createBooking(db, dto)).rejects.toBeInstanceOf(SlotUnavailableError);
    expect(stub.$transaction).not.toHaveBeenCalled();
    // Начальная проверка ключа и проверка после занятого слота — записи нет ни в одном чтении.
    expect(stub.appointment.findUnique).toHaveBeenCalledTimes(2);
  });

  it('P2034 на первой попытке, на повторе слот занят уже нашей записью — 200', async () => {
    const { db, stub } = createDbStub([writeConflictError(), null], {
      findUniqueResults: [null, appointmentRow],
      busy,
      busyFromRetry: true,
    });

    const result = await createBooking(db, dto);

    expect(result.status).toBe(200);
    expect(result.booking.id).toBe(APPOINTMENT_ID);
    // Вторая попытка не дошла до записи: исход решило чтение по ключу.
    expect(stub.$transaction).toHaveBeenCalledTimes(1);
  });
});
