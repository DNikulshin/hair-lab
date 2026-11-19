import type { BookingStatus, PaymentStatus } from '@hair-lab/contracts';
import { describe, expect, it } from 'vitest';
import { env } from '../../shared/config/env';
import type { Db } from '../../shared/db';
import { salonDayWindow } from '../bookings/index';
import { listAdminRefunds } from './admin-refunds.service';

/**
 * Unit-тесты обзора возвратов без PostgreSQL: стаб `Db` реализует ровно те операции, которые
 * делает сервис (`payment.findMany` через фичу платежей и один `appointment.findMany`), и
 * матчит условия `where` по тем же правилам, что Prisma.
 *
 * Здесь проверяется то, что дороже воспроизводить через HTTP: состав обоих списков, границы
 * периода в часовом поясе салона, порядок строк и кап. Данные вымышленные.
 */

const MINUTE_MS = 60_000;

const APPOINTMENT_ID = '00000000-0000-4000-8000-000000000201';
const SECOND_APPOINTMENT_ID = '00000000-0000-4000-8000-000000000202';

/** День в TZ салона и его абсолютные границы: тест не зависит от пояса машины. */
const DATE = '2030-06-15';
const PREVIOUS_DATE = '2030-06-14';
const day = salonDayWindow(DATE, env.SALON_TIMEZONE);
const at = (offsetMs: number) => new Date(day.startsAt.getTime() + offsetMs);

const CLIENT_EMAIL = 'guest@example.invalid';

/** Строка платежа в том виде, в каком её читает сервис платежей. */
interface PaymentRow {
  id: string;
  appointmentId: string;
  status: PaymentStatus;
  amountKopecks: number;
  yookassaPaymentId: string | null;
  refundRequired: boolean;
  refundId: string | null;
  refundStatus: 'succeeded' | 'pending' | 'canceled' | 'unknown' | null;
  createdAt: Date;
}

/** Строка записи в том виде, в каком её читает сервис (`select` с relation). */
interface AppointmentRow {
  id: string;
  startsAt: Date;
  status: BookingStatus;
  cancelReason: string | null;
  clientName: string;
  clientPhone: string;
  clientEmail: string | null;
  master: { fullName: string };
  service: { name: string };
}

function paymentRow(overrides: Partial<PaymentRow> & Pick<PaymentRow, 'id'>): PaymentRow {
  return {
    appointmentId: APPOINTMENT_ID,
    status: 'succeeded',
    amountKopecks: 350_000,
    yookassaPaymentId: `2a1b0d2f-000f-5000-9000-${overrides.id.slice(-12)}`,
    refundRequired: true,
    refundId: null,
    refundStatus: null,
    createdAt: at(12 * 60 * MINUTE_MS),
    ...overrides,
  };
}

function appointmentRow(overrides: Partial<AppointmentRow> = {}): AppointmentRow {
  return {
    id: APPOINTMENT_ID,
    startsAt: at(12 * 60 * MINUTE_MS),
    status: 'cancelled',
    cancelReason: 'cancelled_by_salon: мастер заболел',
    clientName: 'Тестовая Клиентка',
    clientPhone: '+70000000001',
    clientEmail: CLIENT_EMAIL,
    master: { fullName: 'Тестовый Мастер' },
    service: { name: 'Стрижка' },
    ...overrides,
  };
}

type Row = Record<string, unknown>;

/** Сравнение значений: для дат — по времени, для строк — по порядку (как в Postgres). */
function compare(actual: unknown, boundary: unknown): number {
  if (actual instanceof Date && boundary instanceof Date) {
    return actual.getTime() - boundary.getTime();
  }
  return String(actual).localeCompare(String(boundary));
}

/** Условие по значению: примитив, `Date` или набор операторов Prisma (`in`, `gte`, `lt`). */
function matchesValue(actual: unknown, condition: unknown): boolean {
  if (condition instanceof Date) {
    return actual instanceof Date && actual.getTime() === condition.getTime();
  }
  if (condition === null || typeof condition !== 'object') return actual === condition;

  const asRecord = condition as Row;
  if (Array.isArray(asRecord['in'])) return (asRecord['in'] as unknown[]).includes(actual);

  return Object.entries(asRecord).every(([operator, boundary]) => {
    if (!(actual instanceof Date) || !(boundary instanceof Date)) return false;
    switch (operator) {
      case 'gte':
        return actual.getTime() >= boundary.getTime();
      case 'lte':
        return actual.getTime() <= boundary.getTime();
      case 'lt':
        return actual.getTime() < boundary.getTime();
      default:
        return false;
    }
  });
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => matchesValue(row[key], condition));
}

/** Сортировка как у Prisma: список условий, по каждому — `asc`/`desc`. */
function sortRows<T extends object>(rows: T[], orderBy: Row | Row[] | undefined): T[] {
  if (orderBy === undefined) return rows;
  const orders: Row[] = Array.isArray(orderBy) ? orderBy : [orderBy];

  return [...rows].sort((left, right) => {
    const leftRow = left as unknown as Row;
    const rightRow = right as unknown as Row;
    for (const order of orders) {
      for (const [field, direction] of Object.entries(order)) {
        const diff = compare(leftRow[field], rightRow[field]);
        if (diff !== 0) return direction === 'desc' ? -diff : diff;
      }
    }
    return 0;
  });
}

interface FakeState {
  payments: PaymentRow[];
  appointments: AppointmentRow[];
  /** Сколько раз сервис дозагружал контекст записи: проверяем отсутствие N+1. */
  appointmentQueries: number;
}

function createFakeDb(options: { payments?: PaymentRow[]; appointments?: AppointmentRow[] } = {}) {
  const state: FakeState = {
    payments: options.payments ?? [],
    appointments: options.appointments ?? [appointmentRow()],
    appointmentQueries: 0,
  };

  const db = {
    payment: {
      findMany: async ({
        where,
        orderBy,
        take,
      }: {
        where: Row;
        orderBy?: Row | Row[];
        take?: number;
      }) => {
        const rows = state.payments.filter((payment) =>
          matches({ ...payment } as unknown as Row, where),
        );
        const sorted = sortRows(rows, orderBy);
        return (take === undefined ? sorted : sorted.slice(0, take)).map((payment) => ({
          ...payment,
        }));
      },
    },
    appointment: {
      findMany: async ({ where }: { where: Row }) => {
        state.appointmentQueries += 1;
        return state.appointments
          .filter((appointment) => matches({ ...appointment } as unknown as Row, where))
          .map((appointment) => ({ ...appointment }));
      },
    },
  } as unknown as Db;

  return { db, state };
}

describe('listAdminRefunds', () => {
  it('scope=attention: только незавершённые возвраты, статус — в терминах клиента', async () => {
    const pendingId = '00000000-0000-4000-8000-000000000211';
    const failedId = '00000000-0000-4000-8000-000000000212';
    const refundedId = '00000000-0000-4000-8000-000000000213';
    const { db } = createFakeDb({
      payments: [
        paymentRow({ id: pendingId }),
        paymentRow({
          id: failedId,
          refundId: 'refund-9',
          refundStatus: 'canceled',
          createdAt: at(13 * 60 * MINUTE_MS),
        }),
        paymentRow({
          id: refundedId,
          status: 'refunded',
          refundRequired: false,
          refundId: 'refund-10',
          refundStatus: 'succeeded',
        }),
      ],
    });

    const response = await listAdminRefunds(db, { scope: 'attention' });

    expect(response.items.map((item) => item.paymentId)).toEqual([pendingId, failedId]);
    expect(response.items.map((item) => item.refundStatus)).toEqual(['pending', 'failed']);
  });

  it('scope=completed: только зафиксированные возвраты со статусом succeeded', async () => {
    const pendingId = '00000000-0000-4000-8000-000000000221';
    const refundedId = '00000000-0000-4000-8000-000000000222';
    const { db } = createFakeDb({
      payments: [
        paymentRow({ id: pendingId }),
        paymentRow({
          id: refundedId,
          status: 'refunded',
          refundRequired: false,
          refundId: 'refund-11',
          refundStatus: 'succeeded',
          createdAt: at(15 * 60 * MINUTE_MS),
        }),
      ],
    });

    const response = await listAdminRefunds(db, { scope: 'completed' });

    expect(response.items.map((item) => item.paymentId)).toEqual([refundedId]);
    expect(response.items.map((item) => item.refundStatus)).toEqual(['succeeded']);
  });

  it('отдаёт контекст записи и сумму, но не служебные id и не почту клиента', async () => {
    const paymentId = '00000000-0000-4000-8000-000000000231';
    const { db } = createFakeDb({
      payments: [paymentRow({ id: paymentId })],
    });

    const response = await listAdminRefunds(db, { scope: 'attention' });

    expect(response.items[0]).toEqual({
      paymentId,
      appointmentId: APPOINTMENT_ID,
      refundStatus: 'pending',
      amountKopecks: 350_000,
      createdAt: at(12 * 60 * MINUTE_MS).toISOString(),
      appointment: {
        startsAt: at(12 * 60 * MINUTE_MS).toISOString(),
        status: 'cancelled',
        serviceName: 'Стрижка',
        masterName: 'Тестовый Мастер',
        clientName: 'Тестовая Клиентка',
        clientPhone: '+70000000001',
        cancelReason: 'cancelled_by_salon: мастер заболел',
      },
    });
    // Служебные id провайдера и почта клиента в ответ не попадают.
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain(CLIENT_EMAIL);
    expect(serialized).not.toContain('refund-9');
    expect(serialized).not.toContain('yookassaPaymentId');
  });

  it('период считается по дате платежа в TZ салона: день `to` входит целиком', async () => {
    const beforeId = '00000000-0000-4000-8000-000000000241';
    const firstId = '00000000-0000-4000-8000-000000000242';
    const lastId = '00000000-0000-4000-8000-000000000243';
    const afterId = '00000000-0000-4000-8000-000000000244';
    const { db } = createFakeDb({
      payments: [
        // За миллисекунду до местной полуночи и ровно в полночь: граница `from` включительна.
        paymentRow({ id: beforeId, createdAt: new Date(day.startsAt.getTime() - 1) }),
        paymentRow({ id: firstId, createdAt: day.startsAt }),
        // Последняя миллисекунда дня и полночь следующего: граница `to` не включительна.
        paymentRow({ id: lastId, createdAt: new Date(day.endsAt.getTime() - 1) }),
        paymentRow({ id: afterId, createdAt: day.endsAt }),
      ],
    });

    const response = await listAdminRefunds(db, { scope: 'attention', from: DATE, to: DATE });

    expect(response.items.map((item) => item.paymentId)).toEqual([firstId, lastId]);
  });

  it('одна граница периода работает без второй', async () => {
    const beforeId = '00000000-0000-4000-8000-000000000251';
    const insideId = '00000000-0000-4000-8000-000000000252';
    const { db } = createFakeDb({
      payments: [
        paymentRow({ id: beforeId, createdAt: new Date(day.startsAt.getTime() - MINUTE_MS) }),
        paymentRow({ id: insideId, createdAt: day.startsAt }),
      ],
    });

    const fromOnly = await listAdminRefunds(db, { scope: 'attention', from: DATE });
    expect(fromOnly.items.map((item) => item.paymentId)).toEqual([insideId]);

    const toOnly = await listAdminRefunds(db, {
      scope: 'attention',
      to: PREVIOUS_DATE,
    });
    expect(toOnly.items.map((item) => item.paymentId)).toEqual([beforeId]);
  });

  it('отдаёт старые первыми и разрешает одинаковое время по id', async () => {
    const sameTimeFirst = '00000000-0000-4000-8000-000000000261';
    const sameTimeSecond = '00000000-0000-4000-8000-000000000262';
    const newest = '00000000-0000-4000-8000-000000000263';
    const { db } = createFakeDb({
      payments: [
        paymentRow({ id: newest, createdAt: at(14 * 60 * MINUTE_MS) }),
        paymentRow({ id: sameTimeSecond, createdAt: at(10 * 60 * MINUTE_MS) }),
        paymentRow({ id: sameTimeFirst, createdAt: at(10 * 60 * MINUTE_MS) }),
      ],
    });

    const response = await listAdminRefunds(db, { scope: 'attention' });

    expect(response.items.map((item) => item.paymentId)).toEqual([
      sameTimeFirst,
      sameTimeSecond,
      newest,
    ]);
  });

  it('не отдаёт больше 50 строк: кап обзора и самые старые из них', async () => {
    const payments = Array.from({ length: 51 }, (_, index) =>
      paymentRow({
        id: `00000000-0000-4000-8000-0000000003${String(index).padStart(2, '0')}`,
        createdAt: at(index * MINUTE_MS),
      }),
    );
    const { db } = createFakeDb({ payments });

    const response = await listAdminRefunds(db, { scope: 'attention' });

    expect(response.items).toHaveLength(50);
    // Самая новая (51-я) строка в кап не попала: обзор показывает разбор с начала очереди.
    expect(response.items.map((item) => item.paymentId)).not.toContain(payments[50]?.id);
    expect(response.items[0]?.paymentId).toBe(payments[0]?.id);
  });

  it('контекст записи дозагружается одним запросом, а не на строку', async () => {
    const { db, state } = createFakeDb({
      payments: [
        paymentRow({ id: '00000000-0000-4000-8000-000000000271' }),
        paymentRow({
          id: '00000000-0000-4000-8000-000000000272',
          appointmentId: SECOND_APPOINTMENT_ID,
          createdAt: at(13 * 60 * MINUTE_MS),
        }),
      ],
      appointments: [appointmentRow(), appointmentRow({ id: SECOND_APPOINTMENT_ID })],
    });

    const response = await listAdminRefunds(db, { scope: 'attention' });

    expect(response.items.map((item) => item.appointmentId)).toEqual([
      APPOINTMENT_ID,
      SECOND_APPOINTMENT_ID,
    ]);
    expect(state.appointmentQueries).toBe(1);
  });

  it('пустой список валиден и не ходит за записями', async () => {
    const { db, state } = createFakeDb();

    await expect(listAdminRefunds(db, { scope: 'completed' })).resolves.toEqual({ items: [] });
    expect(state.appointmentQueries).toBe(0);
  });

  it('строку без контекста записи не показывает: без неё возврат не разобрать', async () => {
    const { db } = createFakeDb({
      payments: [paymentRow({ id: '00000000-0000-4000-8000-000000000281' })],
      appointments: [appointmentRow({ id: SECOND_APPOINTMENT_ID })],
    });

    await expect(listAdminRefunds(db, { scope: 'attention' })).resolves.toEqual({ items: [] });
  });
});
