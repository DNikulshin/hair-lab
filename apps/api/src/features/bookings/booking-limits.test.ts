import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../../generated/prisma/client';
import type { Db } from '../../shared/db';
import {
  assertPhoneBookingLimits,
  BOOKINGS_IP_MAX,
  BOOKINGS_IP_WINDOW,
  BookingLimitError,
  createBookingsIpRateLimit,
  MAX_ACTIVE_BOOKINGS_PER_PHONE,
  MAX_PENDING_HOLDS_PER_PHONE,
} from './booking-limits';

/**
 * Unit-тесты анти-абьюза `POST /bookings` (#106) без PostgreSQL: проверяем предикаты счёта,
 * порядок «лок → счёт», пороги лимитов и поведение `allowList` у IP-лимита.
 *
 * Важно именно здесь: гонку параллельных запросов на реальной БД проверяет интеграционный
 * тест (`test/bookings-limits.int.test.ts`), а точную форму `where` (что считается активной
 * записью, а что — ожиданием оплаты) дешевле зафиксировать стабом.
 */

/** Вымышленный телефон: не ПДн. */
const PHONE = '+70001112233';
const NOW = new Date('2026-11-19T09:00:00.000Z');

/**
 * Стаб транзакции: `$queryRaw` — advisory-лок, `appointment.count` отвечает по очереди
 * вызовов. `order` фиксирует последовательность: лок обязан идти до счёта, иначе лимит
 * не защищает от гонки.
 */
function createTxStub(counts: readonly number[] = [0, 0]) {
  const order: string[] = [];
  const countArgs: { where?: Record<string, unknown> }[] = [];
  const lockSql: string[] = [];
  const lockValues: unknown[][] = [];
  let countIndex = 0;

  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      order.push('lock');
      lockSql.push(strings.join('?'));
      lockValues.push(values);
      return [];
    }),
    appointment: {
      count: vi.fn(async (args: { where?: Record<string, unknown> }) => {
        order.push('count');
        countArgs.push(args);
        const value = counts[Math.min(countIndex, counts.length - 1)] ?? 0;
        countIndex += 1;
        return value;
      }),
    },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    order,
    countArgs,
    lockSql,
    lockValues,
    count: tx.appointment.count,
  };
}

describe('лимиты телефона: константы', () => {
  it('числа зафиксированы решением владельца и совпадают с docs/decisions.md', () => {
    expect(MAX_ACTIVE_BOOKINGS_PER_PHONE).toBe(3);
    expect(MAX_PENDING_HOLDS_PER_PHONE).toBe(2);
    expect(BOOKINGS_IP_MAX).toBe(10);
    expect(BOOKINGS_IP_WINDOW).toBe('10 minutes');
  });
});

describe('assertPhoneBookingLimits', () => {
  it('берёт advisory-лок по телефону раньше счёта и передаёт номер bind-параметром', async () => {
    const stub = createTxStub([0, 0]);

    await assertPhoneBookingLimits(stub.tx, PHONE, NOW);

    // Лок первым: без него параллельная транзакция прочитала бы тот же count.
    expect(stub.order).toEqual(['lock', 'count', 'count']);
    expect(stub.lockSql[0]).toContain('pg_advisory_xact_lock');
    expect(stub.lockSql[0]).toContain('hashtextextended');
    // Телефон — параметр запроса, а не часть SQL-текста.
    expect(stub.lockValues[0]).toEqual([PHONE]);
    expect(stub.lockSql[0]).not.toContain(PHONE);
  });

  it('активной считается только pending/confirmed с началом в будущем', async () => {
    const stub = createTxStub([0, 0]);

    await assertPhoneBookingLimits(stub.tx, PHONE, NOW);

    const where = stub.countArgs[0]?.where ?? {};
    expect(where.clientPhone).toBe(PHONE);
    expect(where.status).toEqual({ in: ['pending', 'confirmed'] });
    // Граница — «строго позже сейчас»: прошедшая запись место освобождает.
    expect(where.startsAt).toEqual({ gt: NOW });
  });

  it('ожиданием оплаты считается только pending с дедлайном в будущем', async () => {
    const stub = createTxStub([0, 0]);

    await assertPhoneBookingLimits(stub.tx, PHONE, NOW);

    const where = stub.countArgs[1]?.where ?? {};
    expect(where).toEqual({
      clientPhone: PHONE,
      status: 'pending',
      // `gt: now` — предикат, зеркальный свиперу (`lte: now`): истёкший холд не считается.
      paymentDeadlineAt: { gt: NOW },
    });
  });

  it('две активные записи и один холд — ещё можно записаться', async () => {
    const stub = createTxStub([2, 1]);

    await expect(assertPhoneBookingLimits(stub.tx, PHONE, NOW)).resolves.toBeUndefined();
    expect(stub.count).toHaveBeenCalledTimes(2);
  });

  it('третья активная запись достигла порога — BookingLimitError(active_bookings)', async () => {
    const stub = createTxStub([3, 0]);

    const error = await assertPhoneBookingLimits(stub.tx, PHONE, NOW).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BookingLimitError);
    expect((error as BookingLimitError).reason).toBe('active_bookings');
    // Проверка холдов после сработавшего порога уже не нужна: лишнего запроса в БД нет.
    expect(stub.count).toHaveBeenCalledTimes(1);
  });

  it('второй холд достиг порога — BookingLimitError(pending_holds)', async () => {
    const stub = createTxStub([1, 2]);

    const error = await assertPhoneBookingLimits(stub.tx, PHONE, NOW).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BookingLimitError);
    expect((error as BookingLimitError).reason).toBe('pending_holds');
    expect(stub.count).toHaveBeenCalledTimes(2);
  });

  it('считает по времени запроса, а не по часам процесса (дедлайн сравнивается с now)', async () => {
    const stub = createTxStub([0, 0]);
    const later = new Date('2026-11-19T10:00:00.000Z');

    await assertPhoneBookingLimits(stub.tx, PHONE, later);

    expect(stub.countArgs[0]?.where?.startsAt).toEqual({ gt: later });
    expect(stub.countArgs[1]?.where?.paymentDeadlineAt).toEqual({ gt: later });
  });
});

/** Стаб `Db` для `allowList`: отвечает только на чтение записи по ключу идемпотентности. */
function createDbStub(repeated: { id: string } | null) {
  const findUnique = vi.fn(async () => repeated);
  return { db: { appointment: { findUnique } } as unknown as Db, findUnique };
}

/** Тело запроса в том виде, в каком его видит `allowList` (после разбора и валидации). */
function requestWithBody(body: unknown): FastifyRequest {
  return { body } as unknown as FastifyRequest;
}

describe('createBookingsIpRateLimit', () => {
  it('конфиг маршрута: 10 запросов за 10 минут, хук preHandler (тело уже разобрано)', () => {
    const { db } = createDbStub(null);
    const limit = createBookingsIpRateLimit(db);

    expect(limit.max).toBe(10);
    expect(limit.timeWindow).toBe('10 minutes');
    expect(limit.hook).toBe('preHandler');
  });

  it('повтор по существующему idempotencyKey проходит мимо лимита (без инкремента счётчика)', async () => {
    const { db, findUnique } = createDbStub({ id: 'appointment-id' });
    const limit = createBookingsIpRateLimit(db);

    await expect(limit.allowList(requestWithBody({ idempotencyKey: 'key-1' }))).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: 'key-1' },
      select: { id: true },
    });
  });

  it('новый ключ лимитом не освобождается', async () => {
    const { db } = createDbStub(null);
    const limit = createBookingsIpRateLimit(db);

    await expect(limit.allowList(requestWithBody({ idempotencyKey: 'key-2' }))).resolves.toBe(
      false,
    );
  });

  it('невалидное тело или нет ключа — лимит применяется и в БД не ходим', async () => {
    const { db, findUnique } = createDbStub({ id: 'appointment-id' });
    const limit = createBookingsIpRateLimit(db);

    const bodies: unknown[] = [
      undefined,
      null,
      'idempotency-key',
      ['idempotencyKey'],
      {},
      { idempotencyKey: 42 },
      { idempotencyKey: '' },
      { idempotencyKey: null },
    ];

    for (const body of bodies) {
      await expect(limit.allowList(requestWithBody(body))).resolves.toBe(false);
    }
    expect(findUnique).not.toHaveBeenCalled();
  });
});
