import type { BookingStatus } from '@hair-lab/contracts';
import { describe, expect, it, vi } from 'vitest';
import { env } from '../../shared/config/env';
import type { Db } from '../../shared/db';
import {
  BOOKING_CANCELLATION_TYPE,
  BOOKING_CONFIRMATION_TYPE,
  salonDayWindow,
} from '../bookings/index';
import {
  AdminAppointmentConflictError,
  AdminAppointmentNotFoundError,
  cancelAdminAppointment,
  completeAdminAppointment,
  confirmAdminAppointment,
  listAdminAppointments,
  markAdminAppointmentNoShow,
  SALON_CANCEL_REASON_PREFIX,
} from './admin-appointments.service';

/**
 * Unit-тесты админки записей без PostgreSQL: стаб `Db` реализует ровно те операции,
 * которые делает сервис (`updateMany`, `findFirst`, `findFirstOrThrow`, `findMany`), и матчит
 * условия `where` по тем же правилам, что Prisma.
 *
 * Здесь проверяется то, что дорого или неудобно воспроизводить через HTTP: переходы из каждого
 * статуса, идемпотентность повтора (в том числе неизменность `updatedAt`), отличимость салонной
 * причины отмены от клиентской и состав писем в outbox.
 *
 * Данные вымышленные: реальных клиентов и телефонов в тестах нет.
 */

const MINUTE_MS = 60_000;

const NOW = new Date('2030-06-15T09:00:00.000Z');
const BOOKING_ID = '00000000-0000-4000-8000-000000000101';
const OTHER_BOOKING_ID = '00000000-0000-4000-8000-000000000102';
const UNKNOWN_ID = '00000000-0000-4000-8000-0000000001ff';

/** Дата в TZ салона и её абсолютные границы: тест не зависит от пояса машины. */
const DATE = '2030-06-15';
const day = salonDayWindow(DATE, env.SALON_TIMEZONE);
const at = (minutesAfterDayStart: number) =>
  new Date(day.startsAt.getTime() + minutesAfterDayStart * MINUTE_MS);

/** Строка записи в том виде, в каком её читает сервис (`select` с relation). */
interface Row {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: BookingStatus;
  priceKopecks: number;
  durationMin: number;
  clientName: string;
  clientPhone: string;
  clientEmail: string | null;
  cancelReason: string | null;
  updatedAt: Date;
  master: { fullName: string };
  service: { name: string };
}

function row(overrides: Partial<Row> = {}): Row {
  const startsAt = at(12 * 60);
  return {
    id: BOOKING_ID,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 60 * MINUTE_MS),
    status: 'pending',
    priceKopecks: 350_000,
    durationMin: 60,
    clientName: 'Тестовая Клиентка',
    clientPhone: '+70000000001',
    clientEmail: 'guest@example.invalid',
    cancelReason: null,
    updatedAt: new Date('2030-01-01T00:00:00.000Z'),
    master: { fullName: 'Тестовый Мастер' },
    service: { name: 'Стрижка' },
    ...overrides,
  };
}

type Where = Record<string, unknown>;

/** Строка outbox в стабе: проверяет, какие письма ставит и снимает сервис. */
interface OutboxRow {
  id: string;
  type: string;
  appointmentId: string | null;
  status: 'pending' | 'sent' | 'failed' | 'suppressed';
  lastError: string | null;
  payload: unknown;
}

/** Сравнение значений: для дат — по времени, для строк — по порядку (как в Postgres). */
function compare(actual: unknown, boundary: unknown): number {
  if (actual instanceof Date && boundary instanceof Date) {
    return actual.getTime() - boundary.getTime();
  }
  return String(actual).localeCompare(String(boundary));
}

/**
 * Условие по значению: примитив, `Date` или набор операторов Prisma (`in`, `gte`, `lt`, …).
 * Операторы одного поля проверяются вместе: у границ дня в `where` стоят и `gte`, и `lt`.
 */
function matchesValue(actual: unknown, condition: unknown): boolean {
  if (condition instanceof Date) {
    return actual instanceof Date && actual.getTime() === condition.getTime();
  }
  if (typeof condition !== 'object' || condition === null) return actual === condition;

  return Object.entries(condition as Where).every(([operator, boundary]) => {
    switch (operator) {
      case 'in':
        return (boundary as unknown[]).includes(actual);
      case 'notIn':
        return !(boundary as unknown[]).includes(actual);
      case 'gte':
        return compare(actual, boundary) >= 0;
      case 'gt':
        return compare(actual, boundary) > 0;
      case 'lt':
        return compare(actual, boundary) < 0;
      default:
        throw new Error(`стаб не поддерживает условие ${operator}`);
    }
  });
}

function matches(record: object, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
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
 * Стаб `Db` над массивами строк. `updatedAt` при переходе двигается — так тест видит,
 * переписывалась ли запись на повторном запросе. `$transaction` выполняет колбэк над тем же
 * стабом: транзакция в тесте без БД не нужна, важно, какие запросы делает сервис.
 */
function createDbStub(rows: Row[], outboxRows: OutboxRow[] = []) {
  const updateMany = vi.fn(async (args: { where: Where; data: Partial<Row> }) => {
    const matched = rows.filter((record) => matches(record, args.where));
    for (const record of matched) Object.assign(record, args.data, { updatedAt: NOW });
    return { count: matched.length };
  });

  const findFirst = vi.fn(async (args: { where: Where }) => {
    return rows.find((record) => matches(record, args.where)) ?? null;
  });

  const findFirstOrThrow = vi.fn(async (args: { where: Where }) => {
    const found = rows.find((record) => matches(record, args.where));
    if (found === undefined) throw new Error('запись не найдена');
    return found;
  });

  const findMany = vi.fn(
    async (args: { where: Where; orderBy: OrderBy | OrderBy[]; select?: unknown }) => {
      const startsDirection = direction(args.orderBy, 'startsAt');
      const idDirection = direction(args.orderBy, 'id');
      return rows
        .filter((record) => matches(record, args.where))
        .sort((a, b) => {
          const byStart = (a.startsAt.getTime() - b.startsAt.getTime()) * startsDirection;
          if (byStart !== 0) return byStart;
          return a.id.localeCompare(b.id) * idDirection;
        });
    },
  );

  const outboxUpdateMany = vi.fn(async (args: { where: Where; data: Partial<OutboxRow> }) => {
    const matched = outboxRows.filter((record) => matches(record, args.where));
    for (const record of matched) Object.assign(record, args.data);
    return { count: matched.length };
  });

  // Создание письма: production-код не задаёт `lastError` — его ставит дефолт колонки.
  const outboxCreate = vi.fn(
    async (args: { data: { type: string; appointmentId: string | null; payload: unknown } }) => {
      const created: OutboxRow = {
        id: `00000000-0000-4000-8000-0000000002${String(outboxRows.length + 1).padStart(2, '0')}`,
        status: 'pending',
        lastError: null,
        ...args.data,
      };
      outboxRows.push(created);
      return created;
    },
  );

  const db = {
    appointment: { updateMany, findFirst, findFirstOrThrow, findMany },
    outboxMessage: { updateMany: outboxUpdateMany, create: outboxCreate },
    $transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(db as unknown as Db),
  } as unknown as Db;

  return { db, updateMany, findMany, outboxRows, outboxUpdateMany, outboxCreate };
}

describe('listAdminAppointments: день в TZ салона', () => {
  it('отдаёт записи только этого дня, по возрастанию начала', async () => {
    const late = row({ id: OTHER_BOOKING_ID, startsAt: at(16 * 60) });
    const early = row({ id: BOOKING_ID, startsAt: at(10 * 60) });
    const yesterday = row({
      id: '00000000-0000-4000-8000-000000000103',
      startsAt: new Date(day.startsAt.getTime() - MINUTE_MS),
    });
    const tomorrow = row({
      id: '00000000-0000-4000-8000-000000000104',
      startsAt: day.endsAt,
    });
    const { db, findMany } = createDbStub([late, yesterday, early, tomorrow]);

    const response = await listAdminAppointments(db, DATE);

    expect(response.items.map((item) => item.id)).toEqual([early.id, late.id]);
    // Границы дня — полуоткрытый интервал в UTC, посчитанный по TZ салона.
    expect(findMany.mock.calls[0]?.[0].where).toEqual({
      startsAt: { gte: day.startsAt, lt: day.endsAt },
    });
  });

  it('отдаёт DTO админки: ISO-время, имена, цену, полный телефон и причину отмены', async () => {
    const { db } = createDbStub([row()]);

    const [appointment] = (await listAdminAppointments(db, DATE)).items;

    expect(appointment).toEqual({
      id: BOOKING_ID,
      startsAt: at(12 * 60).toISOString(),
      endsAt: new Date(at(12 * 60).getTime() + 60 * MINUTE_MS).toISOString(),
      status: 'pending',
      priceKopecks: 350_000,
      durationMin: 60,
      serviceName: 'Стрижка',
      masterName: 'Тестовый Мастер',
      clientName: 'Тестовая Клиентка',
      clientPhone: '+70000000001',
      // Запись не отменялась: причина есть всегда, значение — `null`.
      cancelReason: null,
    });
    // Почты клиента в ответе нет.
    expect(Object.keys(appointment ?? {})).not.toContain('clientEmail');
  });

  it('отдаёт причину отмены: клиентскую, салонную и служебную оплатную', async () => {
    const byClient = row({
      id: '00000000-0000-4000-8000-000000000201',
      status: 'cancelled',
      cancelReason: 'cancelled_by_client',
    });
    const bySalon = row({
      id: '00000000-0000-4000-8000-000000000202',
      status: 'cancelled',
      cancelReason: `${SALON_CANCEL_REASON_PREFIX}: мастер заболел`,
    });
    const byPayment = row({
      id: '00000000-0000-4000-8000-000000000203',
      status: 'cancelled',
      cancelReason: 'payment_expired',
    });
    const { db } = createDbStub([byClient, bySalon, byPayment]);

    const items = (await listAdminAppointments(db, DATE)).items;

    expect(items.map((item) => item.cancelReason)).toEqual([
      'cancelled_by_client',
      `${SALON_CANCEL_REASON_PREFIX}: мастер заболел`,
      'payment_expired',
    ]);
  });
});

describe('переходы статусов', () => {
  it('confirm: pending → confirmed', async () => {
    const record = row();
    const { db } = createDbStub([record]);

    const appointment = await confirmAdminAppointment(db, BOOKING_ID);

    expect(appointment.status).toBe('confirmed');
    expect(record.status).toBe('confirmed');
    expect(record.cancelReason).toBeNull();
  });

  it('complete и no_show переводят активную запись', async () => {
    for (const [status, run] of [
      ['completed', completeAdminAppointment],
      ['no_show', markAdminAppointmentNoShow],
    ] as const) {
      for (const from of ['pending', 'confirmed'] as const) {
        const record = row({ status: from });
        const { db } = createDbStub([record]);

        const appointment = await run(db, BOOKING_ID);

        expect(appointment.status).toBe(status);
        expect(record.status).toBe(status);
      }
    }
  });

  it('финальные статусы не меняются: 409, запись остаётся как была', async () => {
    const variants: Array<{ from: BookingStatus; run: (db: Db, id: string) => Promise<unknown> }> =
      [
        { from: 'cancelled', run: confirmAdminAppointment },
        { from: 'completed', run: confirmAdminAppointment },
        { from: 'no_show', run: completeAdminAppointment },
        { from: 'completed', run: markAdminAppointmentNoShow },
      ];

    for (const { from, run } of variants) {
      const record = row({
        status: from,
        cancelReason: from === 'cancelled' ? 'cancelled_by_client' : null,
      });
      const { db, outboxUpdateMany, outboxCreate } = createDbStub([record]);

      await expect(run(db, BOOKING_ID)).rejects.toBeInstanceOf(AdminAppointmentConflictError);
      expect(record.status).toBe(from);
      // Отказ не ставит и не снимает писем.
      expect(outboxUpdateMany).not.toHaveBeenCalled();
      expect(outboxCreate).not.toHaveBeenCalled();
    }
  });

  it('неизвестный id — 404 и outbox не тронут', async () => {
    const { db, outboxUpdateMany, outboxCreate } = createDbStub([row()]);

    await expect(confirmAdminAppointment(db, UNKNOWN_ID)).rejects.toBeInstanceOf(
      AdminAppointmentNotFoundError,
    );
    await expect(cancelAdminAppointment(db, UNKNOWN_ID, 'нет такой записи')).rejects.toBeInstanceOf(
      AdminAppointmentNotFoundError,
    );
    expect(outboxUpdateMany).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
  });
});

describe('идемпотентность повтора', () => {
  it('повторное подтверждение — 200 без перезаписи и сдвига updatedAt', async () => {
    const record = row({ status: 'confirmed' });
    const { db, updateMany } = createDbStub([record]);

    const appointment = await confirmAdminAppointment(db, BOOKING_ID);

    expect(appointment.status).toBe('confirmed');
    // Условие перехода не выполнено (запись уже confirmed), поэтому UPDATE не тронул строку.
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(record.updatedAt.toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });

  it('повтор complete и no_show — тоже 200 без изменений', async () => {
    for (const [status, run] of [
      ['completed', completeAdminAppointment],
      ['no_show', markAdminAppointmentNoShow],
    ] as const) {
      const record = row({ status });
      const { db } = createDbStub([record]);

      const appointment = await run(db, BOOKING_ID);

      expect(appointment.status).toBe(status);
      expect(record.updatedAt.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    }
  });
});

describe('cancelAdminAppointment: причина салона и письма', () => {
  it('пишет причину с префиксом салона и ставит письмо об отмене', async () => {
    const confirmation: OutboxRow = {
      id: '00000000-0000-4000-8000-000000000301',
      type: BOOKING_CONFIRMATION_TYPE,
      appointmentId: BOOKING_ID,
      status: 'pending',
      lastError: null,
      payload: {},
    };
    const alreadySent: OutboxRow = {
      ...confirmation,
      id: '00000000-0000-4000-8000-000000000302',
      status: 'sent',
    };
    const record = row({ status: 'confirmed' });
    const { db, outboxRows, outboxUpdateMany, outboxCreate } = createDbStub(
      [record],
      [confirmation, alreadySent],
    );

    const appointment = await cancelAdminAppointment(db, BOOKING_ID, 'мастер заболел');

    expect(appointment.status).toBe('cancelled');
    expect(record.cancelReason).toBe(`${SALON_CANCEL_REASON_PREFIX}: мастер заболел`);
    // DTO отдаёт причину: экран сотрудника показывает, что отменил салон и почему.
    expect(appointment.cancelReason).toBe(`${SALON_CANCEL_REASON_PREFIX}: мастер заболел`);
    // Салонная причина отличима от клиентской — по ней UI #243 понимает, кто отменил.
    expect(record.cancelReason).not.toBe('cancelled_by_client');
    expect(record.cancelReason?.startsWith('cancelled_by_salon: ')).toBe(true);

    // Снято только pending-подтверждение.
    expect(outboxUpdateMany).toHaveBeenCalledTimes(1);
    expect(outboxUpdateMany.mock.calls[0]?.[0]).toEqual({
      where: { appointmentId: BOOKING_ID, type: BOOKING_CONFIRMATION_TYPE, status: 'pending' },
      data: { status: 'suppressed', lastError: 'cancelled' },
    });
    expect(confirmation.status).toBe('suppressed');
    expect(alreadySent.status).toBe('sent');

    // Письмо об отмене — одно, со снимком записи и почтой клиента.
    expect(outboxCreate).toHaveBeenCalledTimes(1);
    expect(outboxRows[2]).toEqual({
      id: expect.any(String),
      type: BOOKING_CANCELLATION_TYPE,
      appointmentId: BOOKING_ID,
      status: 'pending',
      lastError: null,
      payload: {
        clientName: 'Тестовая Клиентка',
        clientEmail: 'guest@example.invalid',
        serviceName: 'Стрижка',
        masterName: 'Тестовый Мастер',
        startsAt: record.startsAt.toISOString(),
        endsAt: record.endsAt.toISOString(),
        priceKopecks: 350_000,
        durationMin: 60,
      },
    });
  });

  it('без почты клиента отмена проходит, подтверждение снимается, письма нет', async () => {
    const confirmation: OutboxRow = {
      id: '00000000-0000-4000-8000-000000000303',
      type: BOOKING_CONFIRMATION_TYPE,
      appointmentId: BOOKING_ID,
      status: 'pending',
      lastError: null,
      payload: {},
    };
    const { db, outboxRows, outboxUpdateMany, outboxCreate } = createDbStub(
      [row({ clientEmail: null })],
      [confirmation],
    );

    const appointment = await cancelAdminAppointment(db, BOOKING_ID, 'клиент просил перенести');

    expect(appointment.status).toBe('cancelled');
    expect(outboxUpdateMany).toHaveBeenCalledTimes(1);
    expect(confirmation.status).toBe('suppressed');
    expect(outboxCreate).not.toHaveBeenCalled();
    expect(outboxRows).toHaveLength(1);
  });

  it('повтор салонной отмены — 200, причина и updatedAt не перезаписываются, письма не дублируются', async () => {
    const confirmation: OutboxRow = {
      id: '00000000-0000-4000-8000-000000000304',
      type: BOOKING_CONFIRMATION_TYPE,
      appointmentId: BOOKING_ID,
      status: 'suppressed',
      lastError: 'cancelled',
      payload: {},
    };
    const cancellation: OutboxRow = {
      id: '00000000-0000-4000-8000-000000000305',
      type: BOOKING_CANCELLATION_TYPE,
      appointmentId: BOOKING_ID,
      status: 'pending',
      lastError: null,
      payload: { clientEmail: 'guest@example.invalid' },
    };
    const record = row({
      status: 'cancelled',
      cancelReason: `${SALON_CANCEL_REASON_PREFIX}: мастер заболел`,
    });
    const { db, outboxRows, outboxUpdateMany, outboxCreate } = createDbStub(
      [record],
      [confirmation, cancellation],
    );

    const appointment = await cancelAdminAppointment(db, BOOKING_ID, 'другая причина');

    expect(appointment.status).toBe('cancelled');
    expect(record.cancelReason).toBe(`${SALON_CANCEL_REASON_PREFIX}: мастер заболел`);
    expect(record.updatedAt.toISOString()).toBe('2030-01-01T00:00:00.000Z');
    expect(outboxUpdateMany).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
    expect(outboxRows).toHaveLength(2);
  });

  it('отмену клиента салонная отмена не перезаписывает: 409', async () => {
    const record = row({ status: 'cancelled', cancelReason: 'cancelled_by_client' });
    const { db, outboxUpdateMany, outboxCreate } = createDbStub([record]);

    await expect(cancelAdminAppointment(db, BOOKING_ID, 'мастер заболел')).rejects.toBeInstanceOf(
      AdminAppointmentConflictError,
    );
    expect(record.cancelReason).toBe('cancelled_by_client');
    expect(outboxUpdateMany).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
  });

  it('запись, отменённую оплатой, тоже не трогает: 409', async () => {
    const record = row({ status: 'cancelled', cancelReason: 'payment_expired' });
    const { db } = createDbStub([record]);

    await expect(cancelAdminAppointment(db, BOOKING_ID, 'мастер заболел')).rejects.toBeInstanceOf(
      AdminAppointmentConflictError,
    );
    expect(record.cancelReason).toBe('payment_expired');
  });
});
