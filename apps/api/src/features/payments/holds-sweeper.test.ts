import { describe, expect, it } from 'vitest';
import type { Db } from '../../shared/db';
import { createHoldsSweeper, type HoldsSweeperLogger } from './holds-sweeper';
import type {
  CreateRefundInput,
  GatewayPayment,
  GatewayRefundStatus,
  PaymentGateway,
} from './payment-gateway';
import { HOLDS_RECONCILE_LIMIT, PAYMENT_EXPIRED_REASON } from './payments.service';

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
const EXPIRED_ID_2 = '33333333-3333-4333-8333-333333333334';

const PAYMENT_REFUND_ID = '44444444-4444-4444-8444-444444444441';
const PAYMENT_REFUND_ID_2 = '44444444-4444-4444-8444-444444444442';
const YOOKASSA_REFUND_ID = '2a1b0d2f-000f-5000-9000-3f0000000001';
const YOOKASSA_REFUND_ID_2 = '2a1b0d2f-000f-5000-9000-3f0000000002';
const YOOKASSA_PAYMENT_ID = '2a1b0d2f-000e-5000-9000-4f0000000001';

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
  refundId: string | null;
  refundStatus: 'succeeded' | 'pending' | 'canceled' | 'unknown' | null;
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
  /** Чтения кандидатов: по ним видно `where` и `take` отбора истёкших холдов. */
  candidates: Array<{ where: Row; take?: number }>;
}

interface FakeOptions {
  appointments?: AppointmentRow[];
  payments?: PaymentRow[];
  /** Ошибка БД: тик обязан её погасить. */
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
    refundId: null,
    refundStatus: null,
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
    candidates: [],
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
      /** Кандидаты на отмену: читаются до сверки, `orderBy` по дедлайну и `take` — лимит тика. */
      findMany: async ({ where, take }: { where: Row; take?: number }) => {
        if (options.error !== undefined) throw options.error;
        state.candidates.push({ where, take });
        const rows = state.appointments
          .filter((item) => matches({ ...item }, where))
          .sort(
            (left, right) =>
              (left.paymentDeadlineAt?.getTime() ?? 0) - (right.paymentDeadlineAt?.getTime() ?? 0),
          );
        return (take === undefined ? rows : rows.slice(0, take)).map((item) => ({ id: item.id }));
      },
      findUnique: async ({ where }: { where: Row }) => {
        const row = state.appointments.find((item) => matches({ ...item }, where));
        return row === undefined ? null : { status: row.status };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        state.selections.push({ model: 'appointment', where });
        let count = 0;
        for (const appointment of state.appointments) {
          if (!matches({ ...appointment }, where)) continue;
          Object.assign(appointment, data);
          count += 1;
        }
        return { count };
      },
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
      updateManyAndReturn: async ({ where, data }: { where: Row; data: Row }): Promise<Row[]> => {
        state.selections.push({ model: 'payment', where });
        const updated: Row[] = [];
        for (const item of state.payments) {
          if (!matches({ ...item }, where)) continue;
          Object.assign(item, data);
          updated.push({ ...item });
        }
        return updated;
      },
      findUnique: async ({ where }: { where: Row }) => {
        const row = state.payments.find((item) => matches({ ...item }, where));
        return row === undefined ? null : withAppointment(row);
      },
      findUniqueOrThrow: async ({ where }: { where: Row }) => {
        const row = state.payments.find((item) => matches({ ...item }, where));
        if (row === undefined) throw new Error('строка платежа не найдена');
        return withAppointment(row);
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
  /** id платежей, состояние которых запрошено у шлюза: по ним видно число сверок и их отбор. */
  checks: string[];
  /** Статус, который отдаёт `createRefund`: по умолчанию возврат завершён. */
  status: GatewayRefundStatus;
  /**
   * Ответ `getPayment` по id платежа в ЮKassa: по умолчанию `pending` — деньги не пришли.
   * `Error` — сбой шлюза (сеть, не-2xx): сверка не удалась, состояние неизвестно.
   */
  paymentState: (yookassaPaymentId: string) => GatewayPayment | Error;
}

/** Состояние платежа в шлюзе: вымышленное, сумма совпадает с суммой платежа в БД. */
function gatewayPayment(overrides: Partial<GatewayPayment> = {}): GatewayPayment {
  return {
    id: YOOKASSA_PAYMENT_ID,
    status: 'pending',
    paid: false,
    amountKopecks: 350_000,
    ...overrides,
  };
}

/**
 * Поддельный шлюз: `createRefund` падает для платежей, перечисленных в `failFor`, и возвращает
 * статус из `status` (по умолчанию — `succeeded`); `getPayment` отдаёт `paymentState`.
 * `createPayment` свипером не используется.
 */
function createFakeGateway(failFor: string[] = []): FakeGateway {
  const calls: CreateRefundInput[] = [];
  const checks: string[] = [];
  const fake: FakeGateway = {
    calls,
    checks,
    status: 'succeeded',
    paymentState: (id) => gatewayPayment({ id }),
    gateway: {
      createPayment: async () => {
        throw new Error('createPayment в свипере не используется');
      },
      getPayment: async (id) => {
        checks.push(id);
        const state = fake.paymentState(id);
        if (state instanceof Error) throw state;
        return state;
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
      // Платёж без id провайдера: сверять не с чем, шлюз не вызывается.
      reconciled: 0,
      confirmed: 0,
      // Обязательных возвратов нет.
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
      obj: { expired: 1, paymentsCanceled: 1, reconciled: 0, appointmentIds: [EXPIRED_ID] },
    });
  });

  it('условия отбора стоят в WHERE финального UPDATE, а не только в сверке', async () => {
    const { db, state } = createFakeDb();
    const { logger } = createLogger();
    const fake = createFakeGateway();
    const sweeper = createHoldsSweeper({
      db,
      gateway: fake.gateway,
      intervalMs: 30_000,
      logger,
    });

    await sweeper.tick(NOW);

    // Отмена ограничена id, статусом и дедлайном: параллельный вебхук выигрывает у свипера.
    expect(state.selections).toEqual([
      {
        model: 'appointment',
        where: { id: { in: [EXPIRED_ID] }, status: 'pending', paymentDeadlineAt: { lte: NOW } },
      },
      { model: 'payment', where: { appointmentId: { in: [EXPIRED_ID] }, status: 'pending' } },
    ]);
    // Платёж без `yookassa_payment_id` отменяется без похода в шлюз.
    expect(fake.checks).toEqual([]);
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
      reconciled: 0,
      confirmed: 0,
      refundsRetried: 0,
      refundsCompleted: 0,
    });
    // Ничего не нашли — ничего не обновляем и в лог не пишем.
    expect(state.candidates).toHaveLength(1);
    expect(state.selections).toHaveLength(0);
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

    // Кандидаты прочитаны, но ни отмены, ни обновления платежей нет.
    expect(state.selections.map((call) => call.model)).toEqual([]);
  });

  it('сверка подтверждает оплату вместо отмены: запись confirmed, платёж succeeded', async () => {
    const { db, state } = createFakeDb({
      appointments: [
        {
          id: EXPIRED_ID,
          status: 'pending',
          cancelReason: null,
          paymentDeadlineAt: EXPIRED_DEADLINE,
        },
      ],
      payments: [
        payment({
          id: 'payment-1',
          appointmentId: EXPIRED_ID,
          yookassaPaymentId: YOOKASSA_PAYMENT_ID,
        }),
      ],
    });
    const { logger, entries } = createLogger();
    const fake = createFakeGateway();
    // Клиент успел заплатить, а вебхук ещё не дошёл: сверка видит `succeeded + paid`.
    fake.paymentState = (id) => gatewayPayment({ id, status: 'succeeded', paid: true });
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
      reconciled: 1,
      confirmed: 1,
      refundsRetried: 0,
      refundsCompleted: 0,
    });
    expect(fake.checks).toEqual([YOOKASSA_PAYMENT_ID]);

    // Тот же путь, что у уведомления: запись подтверждена, дедлайн снят, платёж `succeeded`.
    const appointment = state.appointments.find((row) => row.id === EXPIRED_ID);
    expect(appointment?.status).toBe('confirmed');
    expect(appointment?.paymentDeadlineAt).toBeNull();
    expect(state.payments.find((row) => row.id === 'payment-1')?.status).toBe('succeeded');

    // Отмены не было — в логе только подтверждение.
    expect(entries.some((entry) => entry.msg.includes('отменены'))).toBe(false);
    const confirmation = entries.find((entry) => entry.msg.includes('подтверждена сверкой'));
    expect(confirmation?.level).toBe('info');
    expect(confirmation?.obj).toEqual({ paymentId: 'payment-1', appointmentId: EXPIRED_ID });
  });

  it('ошибка шлюза не отменяет запись: она ждёт и уходит на следующий тик', async () => {
    const { db, state } = createFakeDb({
      appointments: [
        {
          id: EXPIRED_ID,
          status: 'pending',
          cancelReason: null,
          paymentDeadlineAt: EXPIRED_DEADLINE,
        },
      ],
      payments: [
        payment({
          id: 'payment-1',
          appointmentId: EXPIRED_ID,
          yookassaPaymentId: YOOKASSA_PAYMENT_ID,
        }),
      ],
    });
    const { logger, entries } = createLogger();
    const fake = createFakeGateway();
    fake.paymentState = () => new Error('ETIMEDOUT');
    const sweeper = createHoldsSweeper({
      db,
      gateway: fake.gateway,
      intervalMs: 30_000,
      logger,
    });

    const first = await sweeper.tick(NOW);

    // Состояние неизвестно — ни отмены, ни подтверждения: деньги могли уже уйти.
    expect(first).toEqual({
      expired: 0,
      paymentsCanceled: 0,
      reconciled: 0,
      confirmed: 0,
      refundsRetried: 0,
      refundsCompleted: 0,
    });
    expect(state.appointments.find((row) => row.id === EXPIRED_ID)?.status).toBe('pending');
    expect(state.payments.find((row) => row.id === 'payment-1')?.status).toBe('pending');

    // В лог — только id платежа и имя ошибки: ни суммы, ни текста исключения.
    const failure = entries.find((entry) => entry.level === 'error');
    expect(failure?.obj).toEqual({ paymentId: 'payment-1', errorName: 'Error' });
    expect(JSON.stringify(failure?.obj)).not.toContain('TIMEDOUT');

    // Следующий тик: шлюз отвечает `pending` — холд снимается.
    fake.paymentState = (id) => gatewayPayment({ id, status: 'pending' });
    const second = await sweeper.tick(NOW);
    expect(second).toEqual({
      expired: 1,
      paymentsCanceled: 1,
      reconciled: 1,
      confirmed: 0,
      refundsRetried: 0,
      refundsCompleted: 0,
    });
    expect(state.appointments.find((row) => row.id === EXPIRED_ID)?.status).toBe('cancelled');
    expect(state.payments.find((row) => row.id === 'payment-1')?.status).toBe('canceled');
  });

  it('несовпадение суммы — тоже неизвестное состояние: запись жива', async () => {
    const { db, state } = createFakeDb({
      appointments: [
        {
          id: EXPIRED_ID,
          status: 'pending',
          cancelReason: null,
          paymentDeadlineAt: EXPIRED_DEADLINE,
        },
      ],
      payments: [
        payment({
          id: 'payment-1',
          appointmentId: EXPIRED_ID,
          yookassaPaymentId: YOOKASSA_PAYMENT_ID,
        }),
      ],
    });
    const { logger, entries } = createLogger();
    const fake = createFakeGateway();
    // Сумма в шлюзе не наша: переход не выполняется (как и в обработчике уведомления).
    fake.paymentState = (id) =>
      gatewayPayment({ id, status: 'succeeded', paid: true, amountKopecks: 1 });
    const sweeper = createHoldsSweeper({
      db,
      gateway: fake.gateway,
      intervalMs: 30_000,
      logger,
    });

    const result = await sweeper.tick(NOW);

    expect(result).toMatchObject({ expired: 0, reconciled: 1, confirmed: 0 });
    expect(state.appointments.find((row) => row.id === EXPIRED_ID)?.status).toBe('pending');
    expect(state.payments.find((row) => row.id === 'payment-1')?.status).toBe('pending');
    const failure = entries.find((entry) => entry.level === 'error');
    expect(failure?.obj).toEqual({
      paymentId: 'payment-1',
      errorName: 'PaymentAmountMismatchError',
    });
  });

  it('succeeded без paid — не оплата: запись не отменяется и не подтверждается', async () => {
    const { db, state } = createFakeDb({
      appointments: [
        {
          id: EXPIRED_ID,
          status: 'pending',
          cancelReason: null,
          paymentDeadlineAt: EXPIRED_DEADLINE,
        },
      ],
      payments: [
        payment({
          id: 'payment-1',
          appointmentId: EXPIRED_ID,
          yookassaPaymentId: YOOKASSA_PAYMENT_ID,
        }),
      ],
    });
    const { logger, entries } = createLogger();
    const fake = createFakeGateway();
    fake.paymentState = (id) => gatewayPayment({ id, status: 'succeeded', paid: false });
    const sweeper = createHoldsSweeper({
      db,
      gateway: fake.gateway,
      intervalMs: 30_000,
      logger,
    });

    const result = await sweeper.tick(NOW);

    expect(result).toMatchObject({ expired: 0, reconciled: 1, confirmed: 0 });
    expect(state.appointments.find((row) => row.id === EXPIRED_ID)?.status).toBe('pending');
    expect(state.payments.find((row) => row.id === 'payment-1')?.status).toBe('pending');
    const warning = entries.find((entry) => entry.level === 'warn');
    expect(warning?.obj).toEqual({ paymentId: 'payment-1', gatewayStatus: 'succeeded' });
  });

  it('шлюз говорит pending или canceled — холд снимается как раньше', async () => {
    for (const status of ['pending', 'canceled'] as const) {
      const { db, state } = createFakeDb({
        appointments: [
          {
            id: EXPIRED_ID,
            status: 'pending',
            cancelReason: null,
            paymentDeadlineAt: EXPIRED_DEADLINE,
          },
        ],
        payments: [
          payment({
            id: 'payment-1',
            appointmentId: EXPIRED_ID,
            yookassaPaymentId: YOOKASSA_PAYMENT_ID,
          }),
        ],
      });
      const { logger } = createLogger();
      const fake = createFakeGateway();
      fake.paymentState = (id) => gatewayPayment({ id, status });
      const sweeper = createHoldsSweeper({
        db,
        gateway: fake.gateway,
        intervalMs: 30_000,
        logger,
      });

      const result = await sweeper.tick(NOW);

      expect(result, status).toEqual({
        expired: 1,
        paymentsCanceled: 1,
        reconciled: 1,
        confirmed: 0,
        refundsRetried: 0,
        refundsCompleted: 0,
      });
      expect(fake.checks, status).toEqual([YOOKASSA_PAYMENT_ID]);
      expect(state.appointments.find((row) => row.id === EXPIRED_ID)?.status, status).toBe(
        'cancelled',
      );
      expect(state.payments.find((row) => row.id === 'payment-1')?.status, status).toBe('canceled');
      // Отмена ограничена `WHERE`: id, статус и дедлайн — гонка с вебхуком закрыта.
      expect(state.selections[0], status).toEqual({
        model: 'appointment',
        where: {
          id: { in: [EXPIRED_ID] },
          status: 'pending',
          paymentDeadlineAt: { lte: NOW },
        },
      });
    }
  });

  it('платёж без yookassa_payment_id отменяется без вызова шлюза', async () => {
    const { db, state } = createFakeDb({
      appointments: [
        {
          id: EXPIRED_ID,
          status: 'pending',
          cancelReason: null,
          paymentDeadlineAt: EXPIRED_DEADLINE,
        },
        {
          id: EXPIRED_ID_2,
          status: 'pending',
          cancelReason: null,
          paymentDeadlineAt: EXPIRED_DEADLINE,
        },
      ],
      payments: [
        payment({
          id: 'payment-1',
          appointmentId: EXPIRED_ID,
          yookassaPaymentId: YOOKASSA_PAYMENT_ID,
        }),
        // Создание в шлюзе не удалось: id провайдера нет, денег по такому платежу тоже.
        payment({ id: 'payment-2', appointmentId: EXPIRED_ID_2 }),
      ],
    });
    const { logger } = createLogger();
    const fake = createFakeGateway();
    fake.paymentState = (id) => gatewayPayment({ id, status: 'pending' });
    const sweeper = createHoldsSweeper({
      db,
      gateway: fake.gateway,
      intervalMs: 30_000,
      logger,
    });

    const result = await sweeper.tick(NOW);

    expect(result).toMatchObject({ expired: 2, paymentsCanceled: 2, reconciled: 1 });
    expect(fake.checks).toEqual([YOOKASSA_PAYMENT_ID]);
    expect(state.appointments.every((row) => row.status === 'cancelled')).toBe(true);
  });

  it('за тик сверяется не больше HOLDS_RECONCILE_LIMIT холдов', async () => {
    const total = HOLDS_RECONCILE_LIMIT + 1;
    const appointments: AppointmentRow[] = [];
    const payments: PaymentRow[] = [];
    for (let index = 0; index < total; index += 1) {
      const id = `appointment-${index}`;
      appointments.push({
        id,
        status: 'pending',
        cancelReason: null,
        // Отбор идёт по старшинству дедлайна: самый поздний останется на следующий тик.
        paymentDeadlineAt: new Date(EXPIRED_DEADLINE.getTime() + index * 1000),
      });
      payments.push(
        payment({
          id: `payment-${index}`,
          appointmentId: id,
          yookassaPaymentId: `yookassa-${index}`,
        }),
      );
    }
    const { db, state } = createFakeDb({ appointments, payments });
    const { logger } = createLogger();
    const fake = createFakeGateway();
    fake.paymentState = (id) => gatewayPayment({ id, status: 'pending' });
    const sweeper = createHoldsSweeper({
      db,
      gateway: fake.gateway,
      intervalMs: 30_000,
      logger,
    });

    const result = await sweeper.tick(NOW);

    expect(fake.checks).toHaveLength(HOLDS_RECONCILE_LIMIT);
    expect(fake.checks[0]).toBe('yookassa-0');
    expect(result).toMatchObject({
      expired: HOLDS_RECONCILE_LIMIT,
      paymentsCanceled: HOLDS_RECONCILE_LIMIT,
      reconciled: HOLDS_RECONCILE_LIMIT,
      confirmed: 0,
    });
    // Сверх лимита никто не ждёт вечно: необработанный холд остаётся `pending`.
    const waiting = state.appointments.filter((row) => row.status === 'pending');
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.id).toBe(`appointment-${total - 1}`);
  });

  it('постоянно падающая сверка головы выборки не блокирует остальные истёкшие холды', async () => {
    // Голова очереди (первые HOLDS_RECONCILE_LIMIT по дедлайну) каждый тик отдаёт ошибку шлюза:
    // отбор ровно первых N по дедлайну оставил бы следующий холд без сверки навсегда.
    const total = HOLDS_RECONCILE_LIMIT + 1;
    const healthyIndex = total - 1;
    const appointments: AppointmentRow[] = [];
    const payments: PaymentRow[] = [];
    for (let index = 0; index < total; index += 1) {
      const id = `appointment-${index}`;
      appointments.push({
        id,
        status: 'pending',
        cancelReason: null,
        paymentDeadlineAt: new Date(EXPIRED_DEADLINE.getTime() + index * 1000),
      });
      payments.push(
        payment({
          id: `payment-${index}`,
          appointmentId: id,
          yookassaPaymentId: `yookassa-${index}`,
        }),
      );
    }
    const { db, state } = createFakeDb({ appointments, payments });
    const { logger } = createLogger();
    const fake = createFakeGateway();
    // Единственный здоровый холд — последний по дедлайну, за пределами лимита тика.
    fake.paymentState = (id) =>
      id === `yookassa-${healthyIndex}`
        ? gatewayPayment({ id, status: 'pending' })
        : new Error('ETIMEDOUT');
    const sweeper = createHoldsSweeper({
      db,
      gateway: fake.gateway,
      intervalMs: 30_000,
      logger,
    });

    // Первый тик: сверка головы падает, ничего не отменено — деньги могли уйти.
    const first = await sweeper.tick(NOW);
    expect(first).toMatchObject({ expired: 0, paymentsCanceled: 0, reconciled: 0 });
    const firstChecks = [...fake.checks];
    expect(firstChecks).toHaveLength(HOLDS_RECONCILE_LIMIT);
    expect(firstChecks).not.toContain(`yookassa-${healthyIndex}`);

    // Второй тик: упавшая голова отложена, поэтому сверяется и отменяется следующий холд.
    const second = await sweeper.tick(NOW);
    const secondChecks = fake.checks.slice(firstChecks.length);
    expect(second).toMatchObject({ expired: 1, paymentsCanceled: 1, reconciled: 1 });
    expect(secondChecks).toContain(`yookassa-${healthyIndex}`);
    expect(
      state.appointments.filter((row) => row.status === 'cancelled').map((row) => row.id),
    ).toEqual([`appointment-${healthyIndex}`]);
    expect(state.payments.find((row) => row.id === `payment-${healthyIndex}`)?.status).toBe(
      'canceled',
    );

    // Третий тик: отложенные не залипают навсегда — очередь сдвигается и возвращает
    // в отбор те записи, которые пропускались в предыдущем тике.
    const third = await sweeper.tick(NOW);
    const thirdChecks = fake.checks.slice(firstChecks.length + secondChecks.length);
    expect(third).toMatchObject({ expired: 0, paymentsCanceled: 0 });
    const retriedFromDeferred = thirdChecks.filter((id) => !secondChecks.includes(id));
    expect(retriedFromDeferred.length).toBeGreaterThan(0);
    // Перепроверяются именно ранее отложенные записи, а не одни и те же головы выборки.
    expect(retriedFromDeferred.every((id) => firstChecks.includes(id))).toBe(true);
  });

  it('оплата пришла по уже отменённой записи: платёж succeeded и помечен обязательным к возврату', async () => {
    const { db, state } = createFakeDb({
      appointments: [
        {
          id: EXPIRED_ID,
          status: 'pending',
          cancelReason: null,
          paymentDeadlineAt: EXPIRED_DEADLINE,
        },
      ],
      payments: [
        payment({
          id: 'payment-1',
          appointmentId: EXPIRED_ID,
          yookassaPaymentId: YOOKASSA_PAYMENT_ID,
        }),
      ],
    });
    const { logger } = createLogger();
    const fake = createFakeGateway();
    fake.paymentState = (id) => {
      // Пока сверка ждёт ответа шлюза, запись отменили (клиент или салон): гонка,
      // которую закрывает `WHERE` в `applyPaymentSucceeded`.
      const appointment = state.appointments[0];
      if (appointment !== undefined) {
        appointment.status = 'cancelled';
        appointment.cancelReason = 'client_canceled';
      }
      return gatewayPayment({ id, status: 'succeeded', paid: true });
    };
    // Возврат в этом же тике не завершается: флаг обязан остаться в БД.
    fake.status = 'pending';
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
      reconciled: 1,
      confirmed: 1,
      refundsRetried: 1,
      refundsCompleted: 0,
    });
    // Подтвердить отменённую запись нельзя: платёж `succeeded`, возврат помечен обязательным.
    expect(state.appointments.find((row) => row.id === EXPIRED_ID)?.status).toBe('cancelled');
    const paymentRow = state.payments.find((row) => row.id === 'payment-1');
    expect(paymentRow?.status).toBe('succeeded');
    expect(paymentRow?.refundRequired).toBe(true);
    expect(fake.calls).toEqual([
      {
        yookassaPaymentId: YOOKASSA_PAYMENT_ID,
        amountKopecks: 350_000,
        idempotenceKey: 'refund-payment-1',
      },
    ]);
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
      reconciled: 0,
      confirmed: 0,
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
      reconciled: 0,
      confirmed: 0,
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
    // Факт возврата остаётся в БД вместе с переходом в `refunded`.
    expect(refunded?.refundId).toBe('refund-1');
    expect(refunded?.refundStatus).toBe('succeeded');
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
        reconciled: 0,
        confirmed: 0,
        refundsRetried: 1,
        refundsCompleted: 0,
      });
      expect(fake.calls, status).toHaveLength(1);
      expect(fake.calls[0]?.idempotenceKey, status).toBe(`refund-${PAYMENT_REFUND_ID}`);

      // Флаг остаётся: следующий тик повторит возврат с тем же ключом идемпотентности.
      const row = state.payments.find((item) => item.id === PAYMENT_REFUND_ID);
      expect(row?.status, status).toBe('succeeded');
      expect(row?.refundRequired, status).toBe(true);
      // Фактический статус провайдера остаётся в БД: отказ виден не только в логе.
      expect(row?.refundId, status).toBe('refund-1');
      expect(row?.refundStatus, status).toBe(status);

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
      reconciled: 0,
      confirmed: 0,
      refundsRetried: 2,
      refundsCompleted: 1,
    });
    expect(fake.calls).toHaveLength(2);
    // Неудача остаётся флагом: следующий тик повторит возврат.
    const failed = state.payments.find((row) => row.id === PAYMENT_REFUND_ID);
    expect(failed?.status).toBe('succeeded');
    expect(failed?.refundRequired).toBe(true);
    // Сетевой сбой — не факт от провайдера: `refund_id`/`refund_status` не пишутся.
    expect(failed?.refundId).toBeNull();
    expect(failed?.refundStatus).toBeNull();
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

    const where = state.candidates[0]?.where as {
      paymentDeadlineAt: { lte: Date };
    };
    const used = where.paymentDeadlineAt.lte.getTime();
    expect(used).toBeGreaterThanOrEqual(before);
    expect(used).toBeLessThanOrEqual(after);
  });
});
