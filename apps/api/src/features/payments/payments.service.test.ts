import type { BookingStatus, PaymentStatus } from '@hair-lab/contracts';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../shared/db';
import { BOOKING_CONFIRMATION_TYPE } from '../bookings/index';
import {
  applyPaymentCanceled,
  applyPaymentSucceeded,
  findPaymentByAppointment,
  listPendingRefunds,
  markRefunded,
  markRefundRequired,
  PAYMENT_CANCELED_REASON,
  PaymentAmountMismatchError,
} from './payments.service';

/**
 * Доменная логика оплаты на фейковом `Db`: проверяем переходы статусов, идемпотентность
 * и что письмо-подтверждение ставится ровно один раз. Персональные данные вымышленные.
 */
const APPOINTMENT_ID = '33333333-3333-4333-8333-333333333333';
const PAYMENT_ID = '44444444-4444-4444-8444-444444444444';
const AMOUNT = 350_000;

const STARTS_AT = new Date('2030-03-04T06:00:00.000Z');
const ENDS_AT = new Date('2030-03-04T07:00:00.000Z');
const CLIENT_EMAIL = 'guest@example.invalid';
const CREATED_AT = new Date('2030-03-04T05:00:00.000Z');

interface AppointmentRow {
  id: string;
  status: BookingStatus;
  cancelReason: string | null;
  paymentDeadlineAt: Date | null;
  clientName: string;
  clientEmail: string | null;
  startsAt: Date;
  endsAt: Date;
  priceKopecks: number;
  durationMin: number;
  service: { name: string };
  master: { fullName: string };
}

interface PaymentRow {
  id: string;
  appointmentId: string;
  status: PaymentStatus;
  amountKopecks: number;
  yookassaPaymentId: string | null;
  confirmationUrl: string | null;
  refundRequired: boolean;
  createdAt: Date;
}

interface OutboxRow {
  id: string;
  appointmentId: string | null;
  type: string;
  payload: Record<string, unknown>;
  status: string;
}

type Row = Record<string, unknown>;

/** Условия `where`, которые использует сервис: равенство, `in`, `lte` и `not`. */
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

interface FakeState {
  payments: PaymentRow[];
  appointments: AppointmentRow[];
  outbox: OutboxRow[];
  /** Записи вызовов `updateMany`: проверяем, что условия стоят в самом UPDATE. */
  updates: Array<{ model: 'payment' | 'appointment'; where: Row; data: Row }>;
}

interface FakeOptions {
  payment?: Partial<PaymentRow>;
  /** Полный список платежей (для выборки заданий свипера). */
  payments?: PaymentRow[];
  appointment?: Partial<AppointmentRow>;
  outbox?: OutboxRow[];
  /**
   * Гонка: запись отменяется между снимком платежа и условным `UPDATE` записи — `updateMany`
   * не находит строку (`count: 0`), а повторное чтение в той же транзакции отдаёт `cancelled`.
   */
  appointmentCancelledAfterSnapshot?: boolean;
}

function createFakeDb(options: FakeOptions = {}): { db: Db; state: FakeState } {
  const state: FakeState = {
    payments: options.payments ?? [
      {
        id: PAYMENT_ID,
        appointmentId: APPOINTMENT_ID,
        status: 'pending',
        amountKopecks: AMOUNT,
        yookassaPaymentId: '2a1b0d2f-000f-5000-9000-1f0000000000',
        confirmationUrl: 'https://yoomoney.example.invalid/pay',
        refundRequired: false,
        createdAt: CREATED_AT,
        ...options.payment,
      },
    ],
    appointments: [
      {
        id: APPOINTMENT_ID,
        status: 'pending',
        cancelReason: null,
        paymentDeadlineAt: new Date('2030-03-04T05:15:00.000Z'),
        clientName: 'Тестовая Клиентка',
        clientEmail: CLIENT_EMAIL,
        startsAt: STARTS_AT,
        endsAt: ENDS_AT,
        priceKopecks: AMOUNT,
        durationMin: 60,
        service: { name: 'Стрижка' },
        master: { fullName: 'Тестовый Мастер' },
        ...options.appointment,
      },
    ],
    outbox: options.outbox ?? [],
    updates: [],
  };

  /** Строка платежа в форме, которую ждёт сервис: с вложенной записью. */
  const paymentWithAppointment = (payment: PaymentRow): Row => ({
    ...payment,
    appointment: state.appointments.find((row) => row.id === payment.appointmentId),
  });

  const db = {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(db),
    payment: {
      findUnique: async ({ where }: { where: Row }) => {
        const payment = state.payments.find((row) => matches({ ...row }, where));
        return payment === undefined ? null : paymentWithAppointment(payment);
      },
      findUniqueOrThrow: async ({ where }: { where: Row }) => {
        const payment = state.payments.find((row) => matches({ ...row }, where));
        if (payment === undefined) throw new Error('Payment not found');
        return paymentWithAppointment(payment);
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        state.updates.push({ model: 'payment', where, data });
        let count = 0;
        for (const payment of state.payments) {
          if (!matches({ ...payment }, where)) continue;
          Object.assign(payment, data);
          count += 1;
        }
        return { count };
      },
      updateManyAndReturn: async ({ where, data }: { where: Row; data: Row }) => {
        state.updates.push({ model: 'payment', where, data });
        const updated: PaymentRow[] = [];
        for (const payment of state.payments) {
          if (!matches({ ...payment }, where)) continue;
          Object.assign(payment, data);
          updated.push({ ...payment });
        }
        return updated;
      },
      findMany: async ({ where, orderBy, take }: { where: Row; orderBy?: Row; take?: number }) => {
        let rows = state.payments.filter((payment) => matches({ ...payment }, where));
        if (orderBy?.['createdAt'] === 'asc') {
          rows = [...rows].sort(
            (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
          );
        }
        return (take === undefined ? rows : rows.slice(0, take)).map((payment) => ({ ...payment }));
      },
    },
    appointment: {
      findUnique: async ({ where }: { where: Row }) => {
        const appointment = state.appointments.find((row) => matches({ ...row }, where));
        // Сервис читает только статус: остальные поля наружу не отдаются.
        return appointment === undefined ? null : { status: appointment.status };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        state.updates.push({ model: 'appointment', where, data });
        // Гонка: запись отменили после чтения снимка — условие `status: 'pending'` уже не совпадёт.
        if (options.appointmentCancelledAfterSnapshot === true) {
          for (const appointment of state.appointments) {
            if (matches({ ...appointment }, { id: where['id'] })) appointment.status = 'cancelled';
          }
        }
        let count = 0;
        for (const appointment of state.appointments) {
          if (!matches({ ...appointment }, where)) continue;
          Object.assign(appointment, data);
          count += 1;
        }
        return { count };
      },
    },
    outboxMessage: {
      findFirst: async ({ where }: { where: Row }) =>
        state.outbox.find((row) => matches({ ...row }, where)) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row: OutboxRow = {
          id: `outbox-${state.outbox.length + 1}`,
          appointmentId: (data['appointmentId'] as string | null) ?? null,
          type: data['type'] as string,
          payload: data['payload'] as Record<string, unknown>,
          status: 'pending',
        };
        state.outbox.push(row);
        return row;
      },
    },
  };

  return { db: db as unknown as Db, state };
}

describe('applyPaymentSucceeded', () => {
  it('подтверждает запись, ставит письмо и возвращает переход', async () => {
    const { db, state } = createFakeDb();

    const transition = await applyPaymentSucceeded(db, PAYMENT_ID, { amountKopecks: AMOUNT });

    expect(transition).toEqual({
      paymentId: PAYMENT_ID,
      appointmentId: APPOINTMENT_ID,
      status: 'succeeded',
      appointmentStatus: 'confirmed',
      changed: true,
      needsRefund: false,
    });
    expect(state.payments[0]?.status).toBe('succeeded');
    expect(state.appointments[0]?.status).toBe('confirmed');
    // Дедлайн холда снят: ждать больше нечего.
    expect(state.appointments[0]?.paymentDeadlineAt).toBeNull();
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]).toMatchObject({
      appointmentId: APPOINTMENT_ID,
      type: BOOKING_CONFIRMATION_TYPE,
      status: 'pending',
    });
    // Снимок письма собран из записи: время в UTC ISO, цена в копейках.
    expect(state.outbox[0]?.payload).toMatchObject({
      startsAt: STARTS_AT.toISOString(),
      endsAt: ENDS_AT.toISOString(),
      priceKopecks: AMOUNT,
      durationMin: 60,
      serviceName: 'Стрижка',
    });
  });

  it('повтор уведомления — no-op без второго письма', async () => {
    const { db, state } = createFakeDb();

    await applyPaymentSucceeded(db, PAYMENT_ID, { amountKopecks: AMOUNT });
    const repeated = await applyPaymentSucceeded(db, PAYMENT_ID, { amountKopecks: AMOUNT });

    expect(repeated).toEqual({
      paymentId: PAYMENT_ID,
      appointmentId: APPOINTMENT_ID,
      status: 'succeeded',
      appointmentStatus: 'confirmed',
      changed: false,
      needsRefund: false,
    });
    expect(state.outbox).toHaveLength(1);
  });

  it('не ставит второе письмо, если подтверждение уже есть в outbox', async () => {
    const { db, state } = createFakeDb({
      outbox: [
        {
          id: 'outbox-1',
          appointmentId: APPOINTMENT_ID,
          type: BOOKING_CONFIRMATION_TYPE,
          payload: {},
          status: 'pending',
        },
      ],
    });

    await applyPaymentSucceeded(db, PAYMENT_ID, { amountKopecks: AMOUNT });

    expect(state.outbox).toHaveLength(1);
    expect(state.appointments[0]?.status).toBe('confirmed');
  });

  it('без почты клиента письмо не ставится, но запись подтверждается', async () => {
    const { db, state } = createFakeDb({ appointment: { clientEmail: null } });

    await applyPaymentSucceeded(db, PAYMENT_ID, { amountKopecks: AMOUNT });

    expect(state.appointments[0]?.status).toBe('confirmed');
    expect(state.outbox).toHaveLength(0);
  });

  it('оплата после отмены записи: needsRefund, запись остаётся cancelled', async () => {
    const { db, state } = createFakeDb({ appointment: { status: 'cancelled' } });

    const transition = await applyPaymentSucceeded(db, PAYMENT_ID, { amountKopecks: AMOUNT });

    expect(transition).toMatchObject({
      status: 'succeeded',
      appointmentStatus: 'cancelled',
      changed: true,
      needsRefund: true,
    });
    // Факт получения денег фиксируется: возврат делает вызывающий.
    expect(state.payments[0]?.status).toBe('succeeded');
    expect(state.appointments[0]?.status).toBe('cancelled');
    expect(state.outbox).toHaveLength(0);
  });

  it('гонка: запись отменили между снимком и UPDATE — needsRefund по фактическому статусу', async () => {
    // Снимок платежа прочитан, когда запись была `pending`; свипер отменил холд до нашего
    // условного `UPDATE`, поэтому `count === 0`. Статус обязан быть перечитан, иначе возврат
    // по оплаченной отменённой записи не запустится — деньги спишутся без возврата.
    const { db, state } = createFakeDb({ appointmentCancelledAfterSnapshot: true });

    const transition = await applyPaymentSucceeded(db, PAYMENT_ID, { amountKopecks: AMOUNT });

    expect(transition).toEqual({
      paymentId: PAYMENT_ID,
      appointmentId: APPOINTMENT_ID,
      status: 'succeeded',
      appointmentStatus: 'cancelled',
      changed: true,
      needsRefund: true,
    });
    // Деньги действительно получены — это факт, его фиксируем; возврат делает вызывающий.
    expect(state.payments[0]?.status).toBe('succeeded');
    expect(state.appointments[0]?.status).toBe('cancelled');
    // Отменённая запись письма-подтверждения не получает.
    expect(state.outbox).toHaveLength(0);
  });

  it('расхождение суммы — ошибка без изменений', async () => {
    const { db, state } = createFakeDb();

    await expect(
      applyPaymentSucceeded(db, PAYMENT_ID, { amountKopecks: AMOUNT - 1 }),
    ).rejects.toThrow(PaymentAmountMismatchError);

    expect(state.payments[0]?.status).toBe('pending');
    expect(state.appointments[0]?.status).toBe('pending');
    expect(state.outbox).toHaveLength(0);
  });

  it('неизвестный платёж — null: уведомление не про нас', async () => {
    const { db } = createFakeDb();

    await expect(
      applyPaymentSucceeded(db, '99999999-9999-4999-8999-999999999999', { amountKopecks: AMOUNT }),
    ).resolves.toBeNull();
  });

  it('терминальный статус платежа (canceled) не переводит запись в confirmed', async () => {
    const { db, state } = createFakeDb({ payment: { status: 'canceled' } });

    const transition = await applyPaymentSucceeded(db, PAYMENT_ID, { amountKopecks: AMOUNT });

    expect(transition).toMatchObject({ status: 'canceled', changed: false });
    expect(state.appointments[0]?.status).toBe('pending');
    expect(state.outbox).toHaveLength(0);
  });
});

describe('applyPaymentCanceled', () => {
  it('отменяет платёж и запись с причиной payment_canceled', async () => {
    const { db, state } = createFakeDb();

    const transition = await applyPaymentCanceled(db, PAYMENT_ID);

    expect(transition).toEqual({
      paymentId: PAYMENT_ID,
      appointmentId: APPOINTMENT_ID,
      status: 'canceled',
      appointmentStatus: 'cancelled',
      changed: true,
      needsRefund: false,
    });
    expect(state.payments[0]?.status).toBe('canceled');
    expect(state.appointments[0]?.status).toBe('cancelled');
    expect(state.appointments[0]?.cancelReason).toBe(PAYMENT_CANCELED_REASON);
    expect(state.appointments[0]?.paymentDeadlineAt).toBeNull();
    expect(state.outbox).toHaveLength(0);
  });

  it('повтор отмены идемпотентен', async () => {
    const { db, state } = createFakeDb();

    await applyPaymentCanceled(db, PAYMENT_ID);
    const repeated = await applyPaymentCanceled(db, PAYMENT_ID);

    expect(repeated).toMatchObject({ status: 'canceled', changed: false });
    expect(state.appointments[0]?.cancelReason).toBe(PAYMENT_CANCELED_REASON);
  });

  it('подтверждённую запись не отменяет', async () => {
    const { db, state } = createFakeDb({ appointment: { status: 'confirmed' } });

    const transition = await applyPaymentCanceled(db, PAYMENT_ID);

    expect(transition).toMatchObject({ status: 'canceled', appointmentStatus: 'confirmed' });
    expect(state.appointments[0]?.status).toBe('confirmed');
    expect(state.appointments[0]?.cancelReason).toBeNull();
  });

  it('неизвестный платёж — null', async () => {
    const { db } = createFakeDb();

    await expect(
      applyPaymentCanceled(db, '99999999-9999-4999-8999-999999999999'),
    ).resolves.toBeNull();
  });
});

describe('markRefunded', () => {
  it('переводит оплаченный платёж в refunded и возвращает refundId', async () => {
    const { db, state } = createFakeDb({ payment: { status: 'succeeded' } });

    const transition = await markRefunded(db, PAYMENT_ID, 'refund-1');

    expect(transition).toMatchObject({ status: 'refunded', changed: true, refundId: 'refund-1' });
    expect(state.payments[0]?.status).toBe('refunded');
  });

  it('снимает флаг обязательного возврата в той же транзакции', async () => {
    const { db, state } = createFakeDb({
      payment: { status: 'succeeded', refundRequired: true },
    });

    await markRefunded(db, PAYMENT_ID, 'refund-1');

    // Пока флаг стоял, свипер мог бы вернуть деньги второй раз — после возврата его нет.
    expect(state.payments[0]?.status).toBe('refunded');
    expect(state.payments[0]?.refundRequired).toBe(false);
    const refundUpdate = state.updates.find((call) => call.data['status'] === 'refunded');
    expect(refundUpdate?.data).toEqual({ status: 'refunded', refundRequired: false });
  });

  it('повтор возврата — no-op', async () => {
    const { db } = createFakeDb({ payment: { status: 'succeeded' } });

    await markRefunded(db, PAYMENT_ID, 'refund-1');
    const repeated = await markRefunded(db, PAYMENT_ID, 'refund-1');

    expect(repeated).toMatchObject({ status: 'refunded', changed: false, refundId: 'refund-1' });
  });

  it('платёж без денег (pending) не становится refunded', async () => {
    const { db, state } = createFakeDb();

    const transition = await markRefunded(db, PAYMENT_ID, 'refund-1');

    expect(transition).toMatchObject({ status: 'pending', changed: false });
    expect(state.payments[0]?.status).toBe('pending');
  });
});

describe('markRefundRequired', () => {
  it('ставит флаг оплаченному платежу', async () => {
    const { db, state } = createFakeDb({ payment: { status: 'succeeded' } });

    const transition = await markRefundRequired(db, PAYMENT_ID);

    expect(transition).toEqual({
      paymentId: PAYMENT_ID,
      appointmentId: APPOINTMENT_ID,
      status: 'succeeded',
      changed: true,
    });
    expect(state.payments[0]?.refundRequired).toBe(true);
    // Статус не меняется: деньги действительно получены, это факт.
    expect(state.payments[0]?.status).toBe('succeeded');
  });

  it('повтор идемпотентен: флаг остаётся, changed — false', async () => {
    const { db, state } = createFakeDb({ payment: { status: 'succeeded' } });

    await markRefundRequired(db, PAYMENT_ID);
    const repeated = await markRefundRequired(db, PAYMENT_ID);

    expect(repeated).toMatchObject({ status: 'succeeded', changed: false });
    expect(state.payments[0]?.refundRequired).toBe(true);
  });

  it('не трогает платёж без денег (pending)', async () => {
    const { db, state } = createFakeDb();

    const transition = await markRefundRequired(db, PAYMENT_ID);

    expect(transition).toMatchObject({ status: 'pending', changed: false });
    expect(state.payments[0]?.refundRequired).toBe(false);
    // Условия стоят в WHERE самого UPDATE, а не в отдельной проверке до него.
    const update = state.updates.find((call) => call.model === 'payment');
    expect(update?.where).toEqual({
      id: PAYMENT_ID,
      status: { in: ['succeeded', 'canceled'] },
      refundRequired: false,
    });
  });

  it('не трогает уже возвращённый платёж', async () => {
    const { db, state } = createFakeDb({ payment: { status: 'refunded' } });

    const transition = await markRefundRequired(db, PAYMENT_ID);

    expect(transition).toMatchObject({ status: 'refunded', changed: false });
    expect(state.payments[0]?.refundRequired).toBe(false);
  });

  it('отменённый провайдером платёж помечается: деньги могли быть у провайдера', async () => {
    const { db, state } = createFakeDb({ payment: { status: 'canceled' } });

    const transition = await markRefundRequired(db, PAYMENT_ID);

    expect(transition).toMatchObject({ status: 'canceled', changed: true });
    expect(state.payments[0]?.refundRequired).toBe(true);
  });

  it('неизвестный платёж — null', async () => {
    const { db } = createFakeDb();

    await expect(
      markRefundRequired(db, '99999999-9999-4999-8999-999999999999'),
    ).resolves.toBeNull();
  });
});

describe('listPendingRefunds', () => {
  const secondPayment = {
    id: '55555555-5555-4555-8555-555555555555',
    appointmentId: '66666666-6666-4666-8666-666666666666',
    status: 'succeeded' as PaymentStatus,
    amountKopecks: 120_000,
    yookassaPaymentId: '2a1b0d2f-000f-5000-9000-2f0000000000',
    confirmationUrl: null,
    refundRequired: true,
    createdAt: new Date('2030-03-04T05:10:00.000Z'),
  };

  it('отбирает только платежи с флагом и известным id провайдера', async () => {
    const { db } = createFakeDb({
      payments: [
        {
          id: PAYMENT_ID,
          appointmentId: APPOINTMENT_ID,
          status: 'succeeded',
          amountKopecks: AMOUNT,
          yookassaPaymentId: '2a1b0d2f-000f-5000-9000-1f0000000000',
          confirmationUrl: null,
          refundRequired: true,
          createdAt: CREATED_AT,
        },
        secondPayment,
        // Без флага: возвращать нечего.
        {
          id: '77777777-7777-4777-8777-777777777777',
          appointmentId: '88888888-8888-4888-8888-888888888888',
          status: 'succeeded' as PaymentStatus,
          amountKopecks: 50_000,
          yookassaPaymentId: '2a1b0d2f-000f-5000-9000-3f0000000000',
          confirmationUrl: null,
          refundRequired: false,
          createdAt: CREATED_AT,
        },
        // Флаг есть, а id у провайдера нет: возвращать не по чему.
        {
          id: '99999999-9999-4999-8999-999999999999',
          appointmentId: '11111111-1111-4111-8111-111111111111',
          status: 'canceled' as PaymentStatus,
          amountKopecks: 10_000,
          yookassaPaymentId: null,
          confirmationUrl: null,
          refundRequired: true,
          createdAt: CREATED_AT,
        },
      ],
    });

    const pending = await listPendingRefunds(db, 10);

    expect(pending).toEqual([
      {
        paymentId: PAYMENT_ID,
        yookassaPaymentId: '2a1b0d2f-000f-5000-9000-1f0000000000',
        amountKopecks: AMOUNT,
      },
      {
        paymentId: secondPayment.id,
        yookassaPaymentId: secondPayment.yookassaPaymentId,
        amountKopecks: secondPayment.amountKopecks,
      },
    ]);
    // В задании свипера нет ни персональных данных, ни служебных полей записи.
    const serialized = JSON.stringify(pending);
    expect(serialized).not.toContain(CLIENT_EMAIL);
    expect(serialized).not.toContain('Тестовая Клиентка');
    expect(serialized).not.toContain(APPOINTMENT_ID);
  });

  it('уважает лимит и отдаёт старые первыми', async () => {
    const oldest = {
      ...secondPayment,
      id: '22222222-2222-4222-8222-222222222222',
      createdAt: new Date('2030-03-04T04:00:00.000Z'),
    };
    const { db } = createFakeDb({ payments: [secondPayment, oldest] });

    const limited = await listPendingRefunds(db, 1);

    expect(limited).toEqual([
      {
        paymentId: oldest.id,
        yookassaPaymentId: oldest.yookassaPaymentId,
        amountKopecks: oldest.amountKopecks,
      },
    ]);
    // Лимит по умолчанию больше двух заданий: тик забирает оба.
    const all = await listPendingRefunds(db);
    expect(all.map((item) => item.paymentId)).toEqual([oldest.id, secondPayment.id]);
  });

  it('без флагов — пустой список', async () => {
    const { db } = createFakeDb();

    await expect(listPendingRefunds(db)).resolves.toEqual([]);
  });
});

describe('findPaymentByAppointment', () => {
  it('отдаёт статусы и ссылку на оплату без персональных данных', async () => {
    const { db } = createFakeDb();

    const view = await findPaymentByAppointment(db, APPOINTMENT_ID);

    expect(view).toEqual({
      id: PAYMENT_ID,
      appointmentId: APPOINTMENT_ID,
      status: 'pending',
      amountKopecks: AMOUNT,
      yookassaPaymentId: '2a1b0d2f-000f-5000-9000-1f0000000000',
      confirmationUrl: 'https://yoomoney.example.invalid/pay',
      appointmentStatus: 'pending',
    });
    // ПДн клиента в DTO не попадают.
    expect(JSON.stringify(view)).not.toContain(CLIENT_EMAIL);
    expect(JSON.stringify(view)).not.toContain('Тестовая Клиентка');
  });

  it('без платежа — null', async () => {
    const { db } = createFakeDb();

    await expect(
      findPaymentByAppointment(db, '99999999-9999-4999-8999-999999999999'),
    ).resolves.toBeNull();
  });
});
