import { randomUUID } from 'node:crypto';
import {
  adminRefundsResponseSchema,
  apiErrorSchema,
  type BookingStatus,
  type PaymentStatus,
  type StaffRole,
} from '@hair-lab/contracts';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app/build-server';
import { salonDayWindow } from '../src/features/bookings';
import { hashPassword } from '../src/shared/auth/password';
import { env } from '../src/shared/config/env';
import { createFixture, createTestDb, fakeClient } from './db/helpers';

/**
 * Обзор возвратов через HTTP (issue #298): `GET /admin/refunds`.
 *
 * Проверяет критерии задачи на реальной БД:
 * - C1 — список платежей, по которым нужен возврат: статус в терминах клиента и сумма;
 * - C2 — доступ только активному сотруднику с ролью `admin`/`manager`; аноним и клиентская
 *   cookie получают 401;
 * - C3 — маршрут целиком: разделение `scope`, период по `payments.created_at`, 400 на битые
 *   даты и `from > to`, отсутствие служебных id провайдера и почты клиента в теле ответа.
 *
 * Платежи сеются напрямую (`db.payment.create`): маршрут только читает, а нужные состояния
 * (`refund_required`, `refund_status`, `status: 'refunded'`) через HTTP не воспроизвести.
 *
 * Все данные вымышленные: почты только в зоне `example.invalid`, телефоны не существуют.
 */
const db = createTestDb();
const fixture = createFixture(db);
const app = await buildServer();

const MINUTE_MS = 60_000;
const AMOUNT = 350_000;

// Заглушка `example-…` по конвенции репозитория: иначе литерал похож на настоящий секрет.
const password = 'example-staff-password-0298';

const staffIds: string[] = [];
let ipNumber = 90;
function nextIp(): string {
  ipNumber += 1;
  return `10.3.${Math.floor(ipNumber / 250)}.${(ipNumber % 250) + 1}`;
}
const headers = (ip = nextIp()) => ({ 'x-forwarded-for': ip });
const staffEmail = () => `staff-${randomUUID()}@example.invalid`;

/** Сотрудник в БД с хешем вымышленного пароля (как в тесте staff-auth). */
async function createStaff(role: StaffRole): Promise<{ id: string; email: string }> {
  const created = await db.staff.create({
    data: {
      email: staffEmail(),
      passwordHash: await hashPassword(password),
      role,
    },
    select: { id: true, email: true },
  });
  staffIds.push(created.id);
  return created;
}

/** Cookie из ответа `Set-Cookie` (значение сессии сотрудника). */
function sessionCookie(response: Awaited<ReturnType<typeof app.inject>>): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header.join(';') : (header ?? '');
  const match = value.match(/(?:^|,\s*)hl_staff_session=([^;,]+)/);
  if (!match?.[1]) throw new Error('hl_staff_session cookie was not returned');
  return `hl_staff_session=${match[1]}`;
}

/** Вход сотрудника по-настоящему, через маршрут: cookie и сессия в БД настоящие. */
async function loginAsStaff(role: StaffRole): Promise<string> {
  const staff = await createStaff(role);
  const response = await app.inject({
    method: 'POST',
    url: '/staff/auth/login',
    headers: headers(),
    payload: { email: staff.email, password },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response);
}

/** Момент внутри дня `date`: минуты после местной полуночи в TZ салона. */
function at(date: string, minutesAfterMidnight: number): Date {
  const day = salonDayWindow(date, env.SALON_TIMEZONE);
  return new Date(day.startsAt.getTime() + minutesAfterMidnight * MINUTE_MS);
}

/**
 * Своё время для каждой записи: у мастера записи не пересекаются (EXCLUDE-констрейнт),
 * а в одном тесте платежей несколько.
 */
let appointmentSequence = 0;
function nextStartsAt(): Date {
  appointmentSequence += 1;
  return at('2030-06-15', 8 * 60 + appointmentSequence);
}

/** Мастер и услуга: чистка идёт через фикстуру (записи удаляются вместе с ними). */
async function setupCatalog(): Promise<{ masterId: string; serviceId: string }> {
  const masterId = await fixture.master();
  const serviceId = await fixture.service();
  return { masterId, serviceId };
}

interface PaymentOptions {
  /** Статус платежа: `succeeded` — деньги у салона, `refunded` — возврат зафиксирован. */
  status?: PaymentStatus;
  /** Флаг «деньги должны вернуться»: по нему строится список «требуют внимания». */
  refundRequired?: boolean;
  refundStatus?: 'pending' | 'succeeded' | 'canceled' | 'unknown' | null;
  refundId?: string | null;
  createdAt?: Date;
  /** Начало записи: контекст строки и причина отмены. */
  startsAt?: Date;
  appointmentStatus?: BookingStatus;
  cancelReason?: string | null;
}

interface SeededPayment {
  paymentId: string;
  appointmentId: string;
  /** id платежа у провайдера: в ответе его быть не должно. */
  yookassaPaymentId: string;
}

/** Платёж в обход HTTP: нужные состояния возврата задаются прямо в строке. */
async function createPayment(
  masterId: string,
  serviceId: string,
  options: PaymentOptions = {},
): Promise<SeededPayment> {
  const startsAt = options.startsAt ?? nextStartsAt();
  const appointment = await db.appointment.create({
    data: {
      masterId,
      serviceId,
      clientName: fakeClient.name,
      clientPhone: fakeClient.phone,
      // Почта клиента лежит в БД, но в обзор возвратов попадать не должна.
      clientEmail: fakeClient.email,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * MINUTE_MS),
      status: options.appointmentStatus ?? 'cancelled',
      cancelReason: options.cancelReason ?? 'cancelled_by_salon: мастер заболел',
      priceKopecks: AMOUNT,
      durationMin: 60,
    },
    select: { id: true },
  });

  const yookassaPaymentId = `yookassa-${randomUUID()}`;
  const payment = await db.payment.create({
    data: {
      appointmentId: appointment.id,
      amountKopecks: AMOUNT,
      status: options.status ?? 'succeeded',
      yookassaPaymentId,
      refundRequired: options.refundRequired ?? false,
      refundId: options.refundId ?? null,
      refundStatus: options.refundStatus ?? null,
      createdAt: options.createdAt ?? at('2030-06-15', 12 * 60),
    },
    select: { id: true },
  });

  return { paymentId: payment.id, appointmentId: appointment.id, yookassaPaymentId };
}

/** Ответ маршрута, разобранный контрактом. */
function parseResponse(response: Awaited<ReturnType<typeof app.inject>>) {
  expect(response.statusCode).toBe(200);
  return adminRefundsResponseSchema.parse(response.json());
}

/** Только строки своих платежей: в БД прогона могут быть строки других тестов. */
function ownItems(
  response: Awaited<ReturnType<typeof app.inject>>,
  seeded: SeededPayment[],
): string[] {
  const ids = new Set(seeded.map((payment) => payment.paymentId));
  return parseResponse(response)
    .items.map((item) => item.paymentId)
    .filter((paymentId) => ids.has(paymentId));
}

function get(path: string, cookie?: string) {
  return app.inject({
    method: 'GET',
    url: path,
    headers: cookie === undefined ? headers() : { ...headers(), cookie },
  });
}

afterEach(async () => {
  await fixture.cleanup();
  if (staffIds.length > 0) {
    // Сессии сотрудника удаляются каскадом вместе с ним.
    await db.staff.deleteMany({ where: { id: { in: staffIds } } });
    staffIds.length = 0;
  }
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

describe('GET /admin/refunds: доступ', () => {
  it('200 под admin и manager: обзор доступен обеим ролям админки', async () => {
    const { masterId, serviceId } = await setupCatalog();
    const seeded = await createPayment(masterId, serviceId, { refundRequired: true });

    for (const role of ['admin', 'manager'] as const) {
      const cookie = await loginAsStaff(role);
      const response = await get('/admin/refunds', cookie);

      expect(response.statusCode).toBe(200);
      expect(ownItems(response, [seeded])).toEqual([seeded.paymentId]);
    }
  });

  it('без сессии сотрудника — 401, с клиентской cookie — тоже 401', async () => {
    const anonymous = await get('/admin/refunds');
    expect(anonymous.statusCode).toBe(401);
    expect(apiErrorSchema.parse(anonymous.json()).error.code).toBe('unauthorized');

    const clientId = await fixture.client(`client-${randomUUID()}@example.invalid`);
    const clientCookie = `hl_session=${await fixture.session(clientId)}`;
    const withClientCookie = await get('/admin/refunds', clientCookie);
    expect(withClientCookie.statusCode).toBe(401);
    expect(apiErrorSchema.parse(withClientCookie.json()).error.code).toBe('unauthorized');
  });
});

describe('GET /admin/refunds: список и статусы', () => {
  it('по умолчанию отдаёт «требуют внимания»: сумму, статус и контекст записи', async () => {
    const cookie = await loginAsStaff('manager');
    const { masterId, serviceId } = await setupCatalog();
    const pending = await createPayment(masterId, serviceId, {
      refundRequired: true,
      createdAt: at('2030-06-15', 10 * 60),
    });
    const failedStartsAt = at('2030-06-15', 20 * 60);
    const failed = await createPayment(masterId, serviceId, {
      refundRequired: true,
      refundId: 'refund-2f1c-0001',
      refundStatus: 'canceled',
      startsAt: failedStartsAt,
      createdAt: at('2030-06-15', 11 * 60),
    });
    const completed = await createPayment(masterId, serviceId, {
      status: 'refunded',
      refundRequired: false,
      refundId: 'refund-2f1c-0002',
      refundStatus: 'succeeded',
      createdAt: at('2030-06-15', 12 * 60),
    });

    const response = await get('/admin/refunds', cookie);

    // Запрос без `scope` — основной список: завершённый возврат в него не попадает.
    expect(ownItems(response, [pending, failed, completed])).toEqual([
      pending.paymentId,
      failed.paymentId,
    ]);

    const items = parseResponse(response).items;
    const attention = items.find((item) => item.paymentId === failed.paymentId);
    expect(attention?.refundStatus).toBe('failed');
    expect(attention?.amountKopecks).toBe(AMOUNT);
    expect(attention?.appointment).toEqual({
      startsAt: failedStartsAt.toISOString(),
      status: 'cancelled',
      serviceName: 'Стрижка',
      masterName: 'Тестовый Мастер',
      clientName: fakeClient.name,
      clientPhone: fakeClient.phone,
      cancelReason: 'cancelled_by_salon: мастер заболел',
    });
    expect(items.find((item) => item.paymentId === pending.paymentId)?.refundStatus).toBe(
      'pending',
    );

    // Служебные id провайдера, id возврата и почта клиента салону не отдаются.
    expect(response.body).not.toContain(failed.yookassaPaymentId);
    expect(response.body).not.toContain('refund-2f1c-0001');
    expect(response.body).not.toContain(fakeClient.email);
  });

  it('scope=completed отдаёт только зафиксированные возвраты', async () => {
    const cookie = await loginAsStaff('admin');
    const { masterId, serviceId } = await setupCatalog();
    const pending = await createPayment(masterId, serviceId, { refundRequired: true });
    const completed = await createPayment(masterId, serviceId, {
      status: 'refunded',
      refundId: 'refund-2f1c-0003',
      refundStatus: 'succeeded',
      createdAt: at('2030-06-15', 13 * 60),
    });
    // Оплачен и возврата не требует: ни в одном из списков его нет.
    const paid = await createPayment(masterId, serviceId, { createdAt: at('2030-06-15', 14 * 60) });

    const response = await get('/admin/refunds?scope=completed', cookie);

    expect(ownItems(response, [pending, completed, paid])).toEqual([completed.paymentId]);
    const item = parseResponse(response).items.find((row) => row.paymentId === completed.paymentId);
    expect(item?.refundStatus).toBe('succeeded');
    expect(response.body).not.toContain(fakeClient.email);
  });

  it('период считается по дате платежа в TZ салона: день `to` входит целиком', async () => {
    const cookie = await loginAsStaff('manager');
    const { masterId, serviceId } = await setupCatalog();
    const date = '2030-06-15';
    const day = salonDayWindow(date, env.SALON_TIMEZONE);
    const before = await createPayment(masterId, serviceId, {
      refundRequired: true,
      createdAt: new Date(day.startsAt.getTime() - 1),
    });
    const inside = await createPayment(masterId, serviceId, {
      refundRequired: true,
      createdAt: new Date(day.endsAt.getTime() - 1),
    });
    const after = await createPayment(masterId, serviceId, {
      refundRequired: true,
      createdAt: day.endsAt,
    });

    const response = await get(`/admin/refunds?from=${date}&to=${date}`, cookie);

    expect(ownItems(response, [before, inside, after])).toEqual([inside.paymentId]);
  });

  it('битые даты и начало периода позже конца — 400 validation_error', async () => {
    const cookie = await loginAsStaff('manager');

    for (const query of [
      'from=2030-02-30',
      'to=июнь',
      'from=2030-06-16&to=2030-06-15',
      'scope=all',
      'from=2030-06-15T00:00:00.000Z',
    ]) {
      const response = await get(`/admin/refunds?${query}`, cookie);

      expect(response.statusCode).toBe(400);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe('validation_error');
    }
  });

  it('пустой список — валидный ответ, а не ошибка', async () => {
    const cookie = await loginAsStaff('manager');

    const response = await get(
      '/admin/refunds?scope=completed&from=1999-01-01&to=1999-01-02',
      cookie,
    );

    expect(parseResponse(response).items).toEqual([]);
  });
});
