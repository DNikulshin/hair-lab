import type { AccountBookingsQuery, BookingStatus } from '@hair-lab/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../shared/db';
import {
  AccountBookingNotFoundError,
  BookingNotCancellableError,
  CANCEL_MIN_LEAD_MS,
  CANCEL_REASON,
  cancelAccountBooking,
  InvalidCursorError,
  listAccountBookings,
} from './account-bookings.service';

/**
 * Unit-тесты кабинета клиента без PostgreSQL: стаб `Db` реализует ровно те операции,
 * которые делает сервис (`updateMany`, `findFirst`, `findMany`), и матчит условия `where`
 * по тем же правилам, что Prisma.
 *
 * Здесь проверяется то, что дорого или недетерминированно воспроизводить через HTTP:
 * граница дедлайна отмены «ровно два часа» и «на миллисекунду меньше», идемпотентность
 * повторной отмены и неразличимость чужой записи от несуществующей.
 *
 * Данные вымышленные: реальных клиентов и телефонов в тестах нет.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const NOW = new Date('2030-03-04T09:00:00.000Z');
const CLIENT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_CLIENT_ID = '00000000-0000-4000-8000-000000000002';
const BOOKING_ID = '00000000-0000-4000-8000-000000000003';

const CANCELABLE_STARTS_AT = new Date(NOW.getTime() + 3 * DAY_MS);

/** Строка записи в том виде, в каком её читает сервис (`select` с relation). */
interface Row {
  id: string;
  clientId: string | null;
  startsAt: Date;
  endsAt: Date;
  status: BookingStatus;
  priceKopecks: number;
  durationMin: number;
  clientName: string;
  clientPhone: string;
  cancelReason: string | null;
  updatedAt: Date;
  master: { fullName: string };
  service: { name: string };
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: BOOKING_ID,
    clientId: CLIENT_ID,
    startsAt: CANCELABLE_STARTS_AT,
    endsAt: new Date(CANCELABLE_STARTS_AT.getTime() + 60 * MINUTE_MS),
    status: 'confirmed',
    priceKopecks: 350_000,
    durationMin: 60,
    clientName: 'Тестовая Клиентка',
    clientPhone: '+79123456789',
    cancelReason: null,
    updatedAt: new Date('2030-01-01T00:00:00.000Z'),
    master: { fullName: 'Тестовый Мастер' },
    service: { name: 'Стрижка' },
    ...overrides,
  };
}

type Where = Record<string, unknown>;

/** Сравнение значений: для дат — по времени, для строк — по порядку (как в Postgres). */
function compare(actual: unknown, boundary: unknown): number {
  if (actual instanceof Date && boundary instanceof Date) {
    return actual.getTime() - boundary.getTime();
  }
  return String(actual).localeCompare(String(boundary));
}

/** Условие по значению: примитив, `Date` или оператор Prisma (`in`, `gte`, `lt`, …). */
function matchesValue(actual: unknown, condition: unknown): boolean {
  if (condition instanceof Date) {
    return actual instanceof Date && actual.getTime() === condition.getTime();
  }
  if (typeof condition !== 'object' || condition === null) return actual === condition;

  const operators = condition as Where;
  if ('in' in operators) return (operators.in as unknown[]).includes(actual);
  if ('notIn' in operators) return !(operators.notIn as unknown[]).includes(actual);
  if ('gte' in operators) return compare(actual, operators.gte) >= 0;
  if ('gt' in operators) return compare(actual, operators.gt) > 0;
  if ('lt' in operators) return compare(actual, operators.lt) < 0;
  throw new Error(`стаб не поддерживает условие ${JSON.stringify(operators)}`);
}

function matches(record: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    // Сервис склеивает условия через `AND` (в т. ч. фильтр области и условие курсора).
    if (key === 'AND') return (condition as Where[]).every((part) => matches(record, part));
    if (key === 'OR') return (condition as Where[]).some((part) => matches(record, part));
    return matchesValue((record as unknown as Where)[key], condition);
  });
}

interface OrderBy {
  startsAt?: 'asc' | 'desc';
  id?: 'asc' | 'desc';
}

/** Направление из `orderBy`: Prisma принимает и массив, и объект. */
function direction(orders: OrderBy | OrderBy[], key: keyof OrderBy): 1 | -1 {
  const list = Array.isArray(orders) ? orders : [orders];
  const value = list.find((order) => order[key] !== undefined)?.[key];
  return value === 'desc' ? -1 : 1;
}

/**
 * Стаб `Db` над массивом строк. `updatedAt` при отмене двигается — так тест видит,
 * переписывалась ли запись на повторном запросе.
 */
function createDbStub(rows: Row[]) {
  const updateMany = vi.fn(async (args: { where: Where; data: Partial<Row> }) => {
    const matched = rows.filter((record) => matches(record, args.where));
    for (const record of matched) Object.assign(record, args.data, { updatedAt: NOW });
    return { count: matched.length };
  });

  const findFirst = vi.fn(async (args: { where: Where }) => {
    return rows.find((record) => matches(record, args.where)) ?? null;
  });

  const findMany = vi.fn(
    async (args: { where: Where; orderBy: OrderBy | OrderBy[]; take: number }) => {
      const startsDirection = direction(args.orderBy, 'startsAt');
      const idDirection = direction(args.orderBy, 'id');
      const matched = rows
        .filter((record) => matches(record, args.where))
        .sort((a, b) => {
          const byStart = (a.startsAt.getTime() - b.startsAt.getTime()) * startsDirection;
          if (byStart !== 0) return byStart;
          return a.id.localeCompare(b.id) * idDirection;
        });
      return matched.slice(0, args.take);
    },
  );

  const db = { appointment: { updateMany, findFirst, findMany } } as unknown as Db;
  return { db, updateMany, findFirst, findMany };
}

function query(overrides: Partial<AccountBookingsQuery> = {}): AccountBookingsQuery {
  return { limit: 20, scope: 'upcoming', ...overrides };
}

describe('cancelAccountBooking: дедлайн отмены', () => {
  it('ровно за два часа до начала отмена разрешена', async () => {
    const record = row({ startsAt: new Date(NOW.getTime() + CANCEL_MIN_LEAD_MS) });
    const { db } = createDbStub([record]);

    const booking = await cancelAccountBooking(db, CLIENT_ID, BOOKING_ID, NOW);

    expect(booking.status).toBe('cancelled');
    expect(booking.cancellable).toBe(false);
    expect(record.cancelReason).toBe(CANCEL_REASON);
    expect(record.status).toBe('cancelled');
  });

  it('на миллисекунду меньше дедлайна — 409 и запись не меняется', async () => {
    const record = row({ startsAt: new Date(NOW.getTime() + CANCEL_MIN_LEAD_MS - 1) });
    const { db } = createDbStub([record]);

    await expect(cancelAccountBooking(db, CLIENT_ID, BOOKING_ID, NOW)).rejects.toBeInstanceOf(
      BookingNotCancellableError,
    );
    expect(record.status).toBe('confirmed');
    expect(record.cancelReason).toBeNull();
  });

  it('прошедшая запись — 409 даже в активном статусе', async () => {
    for (const status of ['pending', 'confirmed'] as const) {
      const record = row({ status, startsAt: new Date(NOW.getTime() - DAY_MS) });
      const { db, updateMany } = createDbStub([record]);

      await expect(cancelAccountBooking(db, CLIENT_ID, BOOKING_ID, NOW)).rejects.toBeInstanceOf(
        BookingNotCancellableError,
      );
      expect(updateMany).toHaveBeenCalledTimes(1);
      expect(record.status).toBe(status);
      expect(record.cancelReason).toBeNull();
    }
  });

  it('completed и no_show — 409 даже при достаточном сроке', async () => {
    for (const status of ['completed', 'no_show'] as const) {
      const record = row({ status });
      const { db } = createDbStub([record]);

      await expect(cancelAccountBooking(db, CLIENT_ID, BOOKING_ID, NOW)).rejects.toBeInstanceOf(
        BookingNotCancellableError,
      );
      expect(record.status).toBe(status);
      expect(record.cancelReason).toBeNull();
    }
  });

  it('статус pending с достаточным сроком отменяется', async () => {
    const record = row({ status: 'pending' });
    const { db } = createDbStub([record]);

    const booking = await cancelAccountBooking(db, CLIENT_ID, BOOKING_ID, NOW);

    expect(booking.status).toBe('cancelled');
    expect(record.cancelReason).toBe(CANCEL_REASON);
  });
});

describe('cancelAccountBooking: идемпотентность и владелец', () => {
  it('повторная отмена возвращает 200 и не переписывает причину и updatedAt', async () => {
    const record = row({ status: 'cancelled', cancelReason: 'cancelled_by_salon' });
    const { db, updateMany } = createDbStub([record]);

    const booking = await cancelAccountBooking(db, CLIENT_ID, BOOKING_ID, NOW);

    expect(booking.status).toBe('cancelled');
    // Условие отмены не выполнено (запись уже отменена), поэтому UPDATE не тронул строку.
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(record.cancelReason).toBe('cancelled_by_salon');
    expect(record.updatedAt.toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });

  it('чужая запись неотличима от несуществующей: 404, а не 403', async () => {
    const record = row({ clientId: OTHER_CLIENT_ID });
    const { db } = createDbStub([record]);

    await expect(cancelAccountBooking(db, CLIENT_ID, BOOKING_ID, NOW)).rejects.toBeInstanceOf(
      AccountBookingNotFoundError,
    );
    expect(record.status).toBe('confirmed');
    expect(record.cancelReason).toBeNull();
  });

  it('неизвестный id — тоже 404', async () => {
    const { db } = createDbStub([row()]);

    await expect(
      cancelAccountBooking(db, CLIENT_ID, '00000000-0000-4000-8000-0000000000ff', NOW),
    ).rejects.toBeInstanceOf(AccountBookingNotFoundError);
  });
});

describe('cancelAccountBooking: DTO отменённой записи', () => {
  it('отдаёт имена, цену, маску телефона и не отдаёт контакты целиком', async () => {
    const { db } = createDbStub([row()]);

    const booking = await cancelAccountBooking(db, CLIENT_ID, BOOKING_ID, NOW);

    expect(booking).toMatchObject({
      id: BOOKING_ID,
      status: 'cancelled',
      price: { amountMinor: 350_000, currency: 'RUB' },
      durationMin: 60,
      serviceName: 'Стрижка',
      masterName: 'Тестовый Мастер',
      clientName: 'Тестовая Клиентка',
      clientPhoneMasked: '+7 (***) ***-**-89',
      cancellable: false,
      startsAt: CANCELABLE_STARTS_AT.toISOString(),
    });
    expect(Object.keys(booking)).not.toContain('clientPhone');
    expect(Object.keys(booking)).not.toContain('clientEmail');
  });
});

describe('listAccountBookings', () => {
  it('делит записи по статусу и времени и считает cancellable', async () => {
    const futureActive = row({ id: '00000000-0000-4000-8000-000000000011' });
    const soonActive = row({
      id: '00000000-0000-4000-8000-000000000012',
      startsAt: new Date(NOW.getTime() + MINUTE_MS),
    });
    const pastActive = row({
      id: '00000000-0000-4000-8000-000000000013',
      startsAt: new Date(NOW.getTime() - DAY_MS),
    });
    const cancelled = row({
      id: '00000000-0000-4000-8000-000000000014',
      status: 'cancelled',
    });
    const { db } = createDbStub([futureActive, soonActive, pastActive, cancelled]);

    const upcoming = await listAccountBookings(db, CLIENT_ID, query(), NOW);
    expect(upcoming.items.map((item) => item.id)).toEqual([soonActive.id, futureActive.id]);
    // До начала меньше двух часов — кнопку отмены не показываем.
    expect(upcoming.items.map((item) => item.cancellable)).toEqual([false, true]);
    expect(upcoming.nextCursor).toBeNull();

    const past = await listAccountBookings(db, CLIENT_ID, query({ scope: 'past' }), NOW);
    expect(past.items.map((item) => item.id)).toEqual([cancelled.id, pastActive.id]);
    expect(past.items.every((item) => item.cancellable === false)).toBe(true);
  });

  it('не отдаёт чужие и гостевые записи: фильтр по clientId в самом запросе', async () => {
    const own = row({ id: '00000000-0000-4000-8000-000000000021' });
    const foreign = row({ id: '00000000-0000-4000-8000-000000000022', clientId: OTHER_CLIENT_ID });
    const guest = row({ id: '00000000-0000-4000-8000-000000000023', clientId: null });
    const { db, findMany } = createDbStub([own, foreign, guest]);

    const response = await listAccountBookings(db, CLIENT_ID, query(), NOW);

    expect(response.items.map((item) => item.id)).toEqual([own.id]);
    expect(findMany.mock.calls[0]?.[0].where).toMatchObject({ clientId: CLIENT_ID });
  });

  it('пагинация: отдаёт nextCursor и продолжает с него', async () => {
    const first = row({ id: '00000000-0000-4000-8000-000000000031' });
    const second = row({
      id: '00000000-0000-4000-8000-000000000032',
      startsAt: new Date(CANCELABLE_STARTS_AT.getTime() + DAY_MS),
    });
    const third = row({
      id: '00000000-0000-4000-8000-000000000033',
      startsAt: new Date(CANCELABLE_STARTS_AT.getTime() + 2 * DAY_MS),
    });
    const { db } = createDbStub([first, second, third]);

    const page = await listAccountBookings(db, CLIENT_ID, query({ limit: 2 }), NOW);
    expect(page.items.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(page.nextCursor).toBe(`${second.startsAt.toISOString()}|${second.id}`);

    const next = await listAccountBookings(
      db,
      CLIENT_ID,
      query({ limit: 2, cursor: page.nextCursor ?? '' }),
      NOW,
    );
    expect(next.items.map((item) => item.id)).toEqual([third.id]);
    expect(next.nextCursor).toBeNull();
  });

  it('битый курсор — 400, а не пустая страница', async () => {
    const { db } = createDbStub([row()]);

    await expect(
      listAccountBookings(db, CLIENT_ID, query({ cursor: 'not-a-cursor' }), NOW),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(
      listAccountBookings(db, CLIENT_ID, query({ cursor: '2030-03-04T09:00:00.000Z|abc' }), NOW),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });
});
