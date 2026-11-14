import { describe, expect, it } from 'vitest';
import type { Db } from '../../shared/db';
import { createHoldsSweeper, type HoldsSweeperLogger } from './holds-sweeper';
import type { CreateRefundInput, GatewayRefundStatus, PaymentGateway } from './payment-gateway';
import { PAYMENT_EXPIRED_REASON } from './payments.service';

/**
 * Свипер истёкших холдов на фейковом `Db`: проверяем отбор по `payment_deadline_at`,
 * причины отмены, счётчики, состав лога и то, что тик не роняет процесс.
 * Значения вымышленные, персональных данных в тесте нет.
 */
const NOW = new Date('2030-03-04T05:30:00.000Z');
const EXPIRED_DEADLINE = new Date('2030-03-04T05:15:00.000Z');
const FUTURE_DEADLINE = new Date('2030-03-04T05:45:00.000Z');

const EXPIRED_ID = '33333333-3333-4333-8333-333333333331';
const FUTURE_ID = '33333333-3333-4333-8333-333333333332';
const PAID_ID = '33333333-3333-4333-8333-333333333333';

const PAYMENT_REFUND_ID = '44444444-4444-4444-8444-444444444441';
const PAYMENT_REFUND_ID_2 = '44444444-4444-4444-8444-444444444442';
const YOOKASSA_REFUND_ID = '2a1b0d2f-000f-5000-9000-3f0000000001';
const YOOKASSA_REFUND_ID_2 = '2a1b0d2f-000f-5000-9000-3f0000000002';

interface AppointmentRow {
  id: string;
  status: string;
  cancelReason: string | null;
  paymentDeadlineAt: Date | null;
}

interface PaymentRow {
  id: string;
  appointmentId: string;
  status: string;
  amountKopecks: number;
  yookassaPaymentId: string | null;
  confirmationUrl: string | null;
  refundRequired: boolean;
  createdAt: Date;
}

type Row = Record<string, unknown>;

/** Условия, которые использует свипер и фиксация возврата: равенство, `in`, `lte`, `not`. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition !== null && typeof condition === 'object') {
      const asRecord = condition as Record<string, unknown>;
      if (Array.isArray(asRecord['in'])) return (asRecord['in'] as unknown[]).includes(value);
      if ('not' in asRecord) return value !== asRecord['not'];
      if (asRecord['lte'] instanceof Date) {
        return value instanceof Date && value.getTime() <= asRecord['lte'].getTime();
      }
    }
    return value === condition;
  });
}

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  obj: Record<string, unknown>;
  msg: string;
}

function createLogger(): { logger: HoldsSweeperLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    logger: {
      info: (obj, msg) => entries.push({ level: 'info', obj, msg }),
      warn: (obj, msg) => entries.push({ level: 'warn', obj, msg }),
      error: (obj, msg) => entries.push({ level: 'error', obj, msg }),
    },
  };
}

interface FakeState {
  appointments: AppointmentRow[];
  payments: PaymentRow[];
  selections: Array<{ model: string; where: Row }>;
}

interface FakeOptions {
  appointments?: AppointmentRow[];
  payments?: PaymentRow[];
  /** Ошибка транзакции: тик обязан её погасить. */
  error?: Error;
}

const CREATED_AT = new Date('2030-03-04T05:00:00.000Z');

/** Платёж по умолчанию: флага возврата нет, шлюз не вызывается. */
function payment(
  overrides: Partial<PaymentRow> & Pick<PaymentRow, 'id' | 'appointmentId'>,
): PaymentRow {
  return {
    status: 'pending',
    amountKopecks: 350_000,
    yookassaPaymentId: null,
    confirmationUrl: null,
    refundRequired: false,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function createFakeDb(options: FakeOptions = {}): { db: Db; state: FakeState } {
  const state: FakeState = {
    appointments: options.appointments ?? [
      {
        id: EXPIRED_ID,
        status: 'pending',
        cancelReason: null,
        paymentDeadlineAt: EXPIRED_DEADLINE,
      },
      { id: FUTURE_ID, status: 'pending', cancelReason: null, paymentDeadlineAt: FUTURE_DEADLINE },
      // Подтверждённая запись со старым дедлайном: свипер её не трогает.
      { id: PAID_ID, status: 'confirmed', cancelReason: null, paymentDeadlineAt: EXPIRED_DEADLINE },
    ],
    payments: options.payments ?? [
      payment({ id: 'payment-1', appointmentId: EXPIRED_ID }),
      payment({ id: 'payment-2', appointmentId: FUTURE_ID }),
      payment({ id: 'payment-3', appointmentId: PAID_ID, status: 'succeeded' }),
    ],
    selections: [],
  };

  /** Строка платежа в форме, которую ждёт `markRefunded`: с вложенным статусом записи. */
  const withAppointment = (row: PaymentRow): Row => ({
    ...row,
    appointment: state.appointments.find((item) => item.id === row.appointmentId) ?? {
      status: 'cancelled',
    },
  });

  const db = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      if (options.error !== undefined) throw options.error;
      return fn(db);
    },
    appointment: {
      updateManyAndReturn: async ({ where, data }: { where: Row; data: Row }) => {
        state.selections.push({ model: 'appointment', where });
        const updated: Array<{ id: string }> = [];
        for (const appointment of state.appointments) {
          if (!matches({ ...appointment }, where)) continue;
          Object.assign(appointment, data);
          updated.push({ id: appointment.id });
        }
        return updated;
      },
    },
    payment: {
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        state.selections.push({ model: 'payment', where });
        let count = 0;
        for (const item of state.payments) {
          if (!matches({ ...item }, where)) continue;
          Object.assign(item, data);
          count += 1;
        }
        return { count };
      },
      findUnique: async ({ where }: { where: Row }) => {
        const row = state.payments.find((item) => matches({ ...item }, where));
        return row === undefined ? null : withAppointment(row);
      },
      findMany: async ({ where, take }: { where: Row; take?: number }) => {
        const rows = state.payments
          .filter((item) => matches({ ...item }, where))
          .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
        return (take === undefined ? rows : rows.slice(0, take)).map((item) => ({ ...item }));
      },
    },
  };

  return { db: db as unknown as Db, state };
}

interface FakeGateway {
  gateway: PaymentGateway;
  calls: CreateRefundInput[];
  /** Статус, который отдаёт `createRefund`: по умолчанию возврат завершён. */
  status: GatewayRefundStatus;
}

/**
 * Поддельный шлюз: `createRefund` падает для платежей, перечисленных в `failFor`, и возвращает
 * статус из `status` (по умолчанию — `succeeded`). `createPayment` и `getPayment` свипером
 * не используются.
 */
function createFakeGateway(failFor: string[] = []): FakeGateway {
  const calls: CreateRefundInput[] = [];
  const fake: FakeGateway = {
    calls,
    status: 'succeeded',
    gateway: {
      createPayment: async () => {
        throw new Error('createPayment в свипере не используется');
      },
      getPayment: async () => {
        throw new Error('getPayment в свипере не используется');
      },
      createRefund: async (input) => {
        calls.push(input);
        if (failFor.includes(input.yookassaPaymentId)) throw new Error('шлюз недоступен');
        return { refundId: `refund-${calls.length}`, status: fake.status };
      },
    },
  };
  return fake;
}

describe('createHoldsSweeper', () => {
  it('отменяет только истёкшие pending-записи и их pending-платежи', async () => {
    const { db, state } = createFakeDb();
    const { logger, entries } = createLogger();
    const sweeper = createHoldsSweeper({
      db,
      gateway: createFakeGateway().gateway,
      intervalMs: 30_000,
      logger,
    });

    const result = await sweeper.tick(NOW);

    expect(result).toEqual({
      expired: 1,
      paymentsCanceled: 1,
      // Обязательных возвратов нет: шлюз не вызывается.
      refundsRetried: 0,
      refundsCompleted: 0,
    });
    expect(sweeper.intervalMs).toBe(30_000);

    const expired = state.appointments.find((row) => row.id === EXPIRED_ID);
    expect(expired?.status).toBe('cancelled');
    expect(expired?.cancelReason).toBe(PAYMENT_EXPIRED_REASON);

    // Будущий дедлайн и подтверждённую запись не трогаем.
    expect(state.appointments.find((row) => row.id === FUTURE_ID)?.status).toBe('pending');
    expect(state.appointments.find((row) => row.id === PAID_ID)?.status).toBe('confirmed');

    expect(state.payments.find((row) => row.id === 'payment-1')?.status).toBe('canceled');
    expect(state.payments.find((row) => row.id === 'payment-2')?.status).toBe('pending');
    // Деньги по этому платежу уже пришли: возврат делает обработчик уведомления.
    expect(state.payments.find((row) => row.id === 'payment-3')?.status).toBe('succeeded');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'info',
      obj: { expired: 1, paymentsCanceled: 1, appointmentIds: [EXPIRED_ID] },
    });
  });

  it('условия отбора стоят в WHERE самого UPDATE, а не в отдельном чтении', async () => {
    const { db, state } = createFakeDb();
    const { logger } = createLogger();
    const sweeper = createHoldsSweeper({
      db,
      gateway: createFakeGateway().gateway,
      intervalMs: 30_000,
      logger,
    });

    await sweeper.tick(NOW);

    expect(state.selections).toEqual([
      { model: 'appointment', where: { status: 'pending', paymentDeadlineAt: { lte: NOW } } },
      { model: 'payment', where: { appointmentId: { in: [EXPIRED_ID] }, status: 'pending' } },
    ]);
  });

  it('дедлайн в будущем и NULL не считаются истёкшими', async () => {
    const { db, state } = createFakeDb({
      appointments: [
        { id: EXPIRED_ID, status: 'pending', cancelReason: null, paymentDeadlineAt: null },
        {
          id: FUTURE_ID,
          status: 'pending',
          cancelReason: null,
          paymentDeadlineAt: FUTURE_DEADLINE,
        },
      ],
      payments: [],
    });
    const { logger, entries } = createLogger();
    const sweeper = createHoldsSweeper({
      db,
      gateway: createFakeGateway().gateway,
      intervalMs: 30_000,
      logger,
    });

    const result = await sweeper.tick(NOW);

    expect(result).toEqual({
      expired: 0,
      paymentsCanceled: 0,
      refundsRetried: 0,
      refundsCompleted: 0,
    });
    // Ничего не нашли — платежи не трогаем и в лог не пишем.
    expect(state.selections).toHaveLength(1);
    expect(entries).toHaveLength(0);
  });

  it('без истёкших записей платёж не обновляется', async () => {
    const { db, state } = createFakeDb({
      appointments: [
        {
          id: FUTURE_ID,
          status: 'pending',
          cancelReason: null,
          paymentDeadlineAt: FUTURE_DEADLINE,
        },
      ],
    });
    const { logger } = createLogger();
    const sweeper = createHoldsSweeper({
      db,
      gateway: createFakeGateway().gateway,
      intervalMs: 30_000,
      logger,
    });

    await sweeper.tick(NOW);

    expect(state.selections.map((call) => call.model)).toEqual(['appointment']);
  });

  it('ошибка БД гасится: тик возвращает нули и пишет в лог только имя ошибки', async () => {
    const { db } = createFakeDb({ error: new Error('connect ECONNREFUSED 127.0.0.1:5432') });
    const { logger, entries } = createLogger();
    const sweeper = createHoldsSweeper({
      db,
      gateway: createFakeGateway().gateway,
      intervalMs: 30_000,
      logger,
    });

    const result = await sweeper.tick(NOW);

    expect(result).toEqual({
      expired: 0,
      paymentsCanceled: 0,
      refundsRetried: 0,
      refundsCompleted: 0,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('error');
    expect(entries[0]?.obj).toEqual({ errorName: 'Error' });
    // Текст исключения (адрес БД, значения строк) в лог не попадает.
    expect(JSON.stringify(entries[0]?.obj)).not.toContain('5432');
  });

  it('повторяет обязательные возвраты и снимает флаг', async () => {
    // Истёкших холдов нет: тик занимается только возвратами.
    const { db, state } = createFakeDb({
      appointments: [
        {
          id: FUTURE_ID,
          status: 'pending',
          cancelReason: null,
          paymentDeadlineAt: FUTURE_DEADLINE,
        },
      ],
      payments: [
        payment({
          id: PAYMENT_REFUND_ID,
          appointmentId: FUTURE_ID,
          status: 'succeeded',
          yookassaPaymentId: YOOKASSA_REFUND_ID,
          refundRequired: true,
        }),
      ],
    });
    const { logger, entries } = createLogger();
    const fake = createFakeGateway();
    const sweeper = createHoldsSweeper({
      db,
      gateway: fake.gateway,
      intervalMs: 30_000,
      logger,
    });

    const result = await sweeper.tick(NOW);

    expect(result).toEqual({
      expired: 0,
      paymentsCanceled: 0,
      refundsRetried: 1,
      refundsCompleted: 1,
    });
    // Ключ тот же, что в маршруте уведомления: повтор не вернёт деньги дважды.
    expect(fake.calls).toEqual([
      {
        yookassaPaymentId: YOOKASSA_REFUND_ID,
        amountKopecks: 350_000,
        idempotenceKey: `refund-${PAYMENT_REFUND_ID}`,
      },
    ]);
    const refunded = state.payments.find((row) => row.id === PAYMENT_REFUND_ID);
    expect(refunded?.status).toBe('refunded');
    expect(refunded?.refundRequired).toBe(false);
    expect(entries.some((entry) => entry.obj['refundId'] === 'refund-1')).toBe(true);
  });

  it('незавершённый возврат не снимает флаг и повторяется следующим тиком', async () => {
    // Статусы, которые не значат «деньги вернулись»: `pending` — в пути, `canceled` — отказ,
    // `unknown` — нераспознанный ответ. Ни один не должен перевести платёж в `refunded`.
    for (const status of ['pending', 'canceled', 'unknown'] as const) {
      const { db, state } = createFakeDb({
        appointments: [
          {
            id: FUTURE_ID,
            status: 'pending',
            cancelReason: null,
            paymentDeadlineAt: FUTURE_DEADLINE,
          },
        ],
        payments: [
          payment({
            id: PAYMENT_REFUND_ID,
            appointmentId: FUTURE_ID,
            status: 'succeeded',
            yookassaPaymentId: YOOKASSA_REFUND_ID,
            refundRequired: true,
          }),
        ],
      });
      const { logger, entries } = createLogger();
      const fake = createFakeGateway();
      fake.status = status;
      const sweeper = createHoldsSweeper({
        db,
        gateway: fake.gateway,
        intervalMs: 30_000,
        logger,
      });

      const result = await sweeper.tick(NOW);

      // Попытка была, но завершённого возврата нет: деньги клиенту не вернулись.
      expect(result, status).toEqual({
        expired: 0,
        paymentsCanceled: 0,
        refundsRetried: 1,
        refundsCompleted: 0,
      });
      expect(fake.calls, status).toHaveLength(1);
      expect(fake.calls[0]?.idempotenceKey, status).toBe(`refund-${PAYMENT_REFUND_ID}`);

      // Флаг остаётся: следующий тик повторит возврат с тем же ключом идемпотентности.
      const row = state.payments.find((item) => item.id === PAYMENT_REFUND_ID);
      expect(row?.status, status).toBe('succeeded');
      expect(row?.refundRequired, status).toBe(true);

      const failure = entries.find((entry) => entry.level === 'error');
      expect(failure?.obj, status).toEqual({
        paymentId: PAYMENT_REFUND_ID,
        refundId: 'refund-1',
        refundStatus: status,
      });
      // Адрес отказа ищет человек, остальное добивает свипер.
      expect(failure?.msg, status).toContain(
        status === 'canceled' ? 'ручная проверка' : 'повторим',
      );
    }
  });

  it('ошибка возврата не мешает следующему и не роняет тик', async () => {
    const { db, state } = createFakeDb({
      appointments: [
        {
          id: FUTURE_ID,
          status: 'pending',
          cancelReason: null,
          paymentDeadlineAt: FUTURE_DEADLINE,
        },
      ],
      payments: [
        payment({
          id: PAYMENT_REFUND_ID,
          appointmentId: FUTURE_ID,
          status: 'succeeded',
          yookassaPaymentId: YOOKASSA_REFUND_ID,
          refundRequired: true,
        }),
        payment({
          id: PAYMENT_REFUND_ID_2,
          appointmentId: FUTURE_ID,
          status: 'canceled',
          yookassaPaymentId: YOOKASSA_REFUND_ID_2,
          refundRequired: true,
          createdAt: new Date(CREATED_AT.getTime() + 60_000),
        }),
      ],
    });
    const { logger, entries } = createLogger();
    const fake = createFakeGateway([YOOKASSA_REFUND_ID]);
    const sweeper = createHoldsSweeper({
      db,
      gateway: fake.gateway,
      intervalMs: 30_000,
      logger,
    });

    const result = await sweeper.tick(NOW);

    expect(result).toEqual({
      expired: 0,
      paymentsCanceled: 0,
      refundsRetried: 2,
      refundsCompleted: 1,
    });
    expect(fake.calls).toHaveLength(2);
    // Неудача остаётся флагом: следующий тик повторит возврат.
    const failed = state.payments.find((row) => row.id === PAYMENT_REFUND_ID);
    expect(failed?.status).toBe('succeeded');
    expect(failed?.refundRequired).toBe(true);
    expect(state.payments.find((row) => row.id === PAYMENT_REFUND_ID_2)?.status).toBe('refunded');

    // В лог об ошибке — только id платежа и имя ошибки: ни суммы, ни текста исключения.
    const failure = entries.find((entry) => entry.level === 'error');
    expect(failure?.obj).toEqual({ paymentId: PAYMENT_REFUND_ID, errorName: 'Error' });
    expect(JSON.stringify(failure?.obj)).not.toContain('350');
  });

  it('без платежей с флагом шлюз не вызывается', async () => {
    const { db } = createFakeDb({
      appointments: [
        {
          id: FUTURE_ID,
          status: 'pending',
          cancelReason: null,
          paymentDeadlineAt: FUTURE_DEADLINE,
        },
      ],
      payments: [
        payment({
          id: PAYMENT_REFUND_ID,
          appointmentId: FUTURE_ID,
          status: 'succeeded',
          yookassaPaymentId: YOOKASSA_REFUND_ID,
        }),
      ],
    });
    const { logger, entries } = createLogger();
    const fake = createFakeGateway();
    const sweeper = createHoldsSweeper({
      db,
      gateway: fake.gateway,
      intervalMs: 30_000,
      logger,
    });

    const result = await sweeper.tick(NOW);

    expect(result).toMatchObject({ refundsRetried: 0, refundsCompleted: 0 });
    expect(fake.calls).toEqual([]);
    expect(entries).toHaveLength(0);
  });

  it('без аргумента берёт текущий момент', async () => {
    const { db, state } = createFakeDb();
    const { logger } = createLogger();
    const sweeper = createHoldsSweeper({
      db,
      gateway: createFakeGateway().gateway,
      intervalMs: 30_000,
      logger,
    });

    const before = Date.now();
    await sweeper.tick();
    const after = Date.now();

    const where = state.selections[0]?.where as {
      paymentDeadlineAt: { lte: Date };
    };
    const used = where.paymentDeadlineAt.lte.getTime();
    expect(used).toBeGreaterThanOrEqual(before);
    expect(used).toBeLessThanOrEqual(after);
  });
});
