import { randomUUID } from 'node:crypto';
import {
  adminAppointmentResponseSchema,
  adminAppointmentsResponseSchema,
  apiErrorSchema,
  type BookingStatus,
  type StaffRole,
} from '@hair-lab/contracts';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app/build-server';
import {
  BOOKING_CANCELLATION_TYPE,
  BOOKING_CONFIRMATION_TYPE,
  salonDayWindow,
} from '../src/features/bookings';
import { hashPassword } from '../src/shared/auth/password';
import { env } from '../src/shared/config/env';
import { createFixture, createTestDb, fakeClient } from './db/helpers';

/**
 * Админка записей через HTTP (issue #242): `GET /admin/appointments` и переходы
 * `confirm` / `cancel` / `complete` / `no-show` на реальной БД.
 *
 * Проверяет: доступ только по сессии сотрудника (клиентская cookie не подходит), список дня
 * с сортировкой и полным телефоном клиента, все переходы и их идемпотентность (повтор 200
 * без сдвига `updatedAt`), 409 на терминальных статусах, 404 на неизвестной записи,
 * письмо `booking_cancellation` и подавленное подтверждение в outbox при салонной отмене,
 * 400 на неверную дату и пустую причину, матрицу ролей (#252): `manager` ведёт день, но
 * отменять салоном может только `admin` — 403 `forbidden`.
 *
 * По умолчанию сотрудник — `manager`: так основной сценарий проверяет самую узкую из
 * допустимых ролей, а `admin` берётся там, где без него действие запрещено.
 *
 * Все данные вымышленные: почты только в зоне `example.invalid`, телефоны не существуют.
 */
const db = createTestDb();
const fixture = createFixture(db);
const app = await buildServer();

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// Заглушка `example-…` по конвенции репозитория: иначе литерал похож на настоящий секрет
// и красит гейт `secrets_scan` (как в тесте staff-auth).
const password = 'example-staff-password-0002';

const staffIds: string[] = [];
let ipNumber = 70;
function nextIp(): string {
  ipNumber += 1;
  return `10.2.${Math.floor(ipNumber / 250)}.${(ipNumber % 250) + 1}`;
}
const headers = (ip = nextIp()) => ({ 'x-forwarded-for': ip });
const staffEmail = () => `staff-${randomUUID()}@example.invalid`;

/** Сотрудник в БД с хешем вымышленного пароля (как в тесте staff-auth). */
async function createStaff(role: StaffRole = 'manager'): Promise<{ id: string; email: string }> {
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
async function loginAsStaff(role: StaffRole = 'manager'): Promise<string> {
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

/** Календарная дата через N дней в TZ салона: тест не зависит от пояса машины. */
function salonDatePlus(days: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: env.SALON_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(Date.now() + days * DAY_MS));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** Момент внутри дня `date`: минуты после местной полуночи в TZ салона. */
function at(date: string, minutesAfterMidnight: number): Date {
  const day = salonDayWindow(date, env.SALON_TIMEZONE);
  return new Date(day.startsAt.getTime() + minutesAfterMidnight * MINUTE_MS);
}

/** Мастер, услуга: чистка идёт через фикстуру (записи удаляются вместе с ними). */
async function setupCatalog(): Promise<{ masterId: string; serviceId: string }> {
  const masterId = await fixture.master();
  const serviceId = await fixture.service();
  return { masterId, serviceId };
}

interface AppointmentOptions {
  status?: BookingStatus;
  clientEmail?: string | null;
}

/** Запись в обход HTTP: время и статус нужны тесту, а не сценарию записи. */
async function createAppointment(
  masterId: string,
  serviceId: string,
  startsAt: Date,
  options: AppointmentOptions = {},
): Promise<string> {
  const created = await db.appointment.create({
    data: {
      masterId,
      serviceId,
      clientName: fakeClient.name,
      clientPhone: fakeClient.phone,
      clientEmail: options.clientEmail === undefined ? fakeClient.email : options.clientEmail,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * MINUTE_MS),
      status: options.status ?? 'pending',
      priceKopecks: 350_000,
      durationMin: 60,
    },
    select: { id: true },
  });
  return created.id;
}

/** Строка записи из БД — только служебные поля, без ПДн в ожиданиях. */
function readAppointment(id: string) {
  return db.appointment.findFirstOrThrow({
    where: { id },
    select: { status: true, cancelReason: true, updatedAt: true },
  });
}

/** Outbox записи: только тип, статус и код причины — содержимое письма тест не печатает. */
function readOutbox(appointmentId: string) {
  return db.outboxMessage.findMany({
    where: { appointmentId },
    select: { type: true, status: true, lastError: true },
    orderBy: { createdAt: 'asc' },
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

describe('GET /admin/appointments', () => {
  it('отдаёт записи дня по возрастанию начала, с полным телефоном клиента', async () => {
    const cookie = await loginAsStaff();
    const { masterId, serviceId } = await setupCatalog();
    const date = salonDatePlus(3);
    const lateId = await createAppointment(masterId, serviceId, at(date, 16 * 60), {
      status: 'confirmed',
    });
    const earlyId = await createAppointment(masterId, serviceId, at(date, 10 * 60));
    // Соседние дни: в список выбранной даты не попадают.
    await createAppointment(masterId, serviceId, new Date(at(date, 0).getTime() - MINUTE_MS));
    await createAppointment(masterId, serviceId, at(salonDatePlus(4), 10 * 60));

    const response = await app.inject({
      method: 'GET',
      url: `/admin/appointments?date=${date}`,
      headers: { ...headers(), cookie },
    });

    expect(response.statusCode).toBe(200);
    const parsed = adminAppointmentsResponseSchema.parse(response.json());
    expect(parsed.items.map((item) => item.id)).toEqual([earlyId, lateId]);
    expect(parsed.items.map((item) => item.status)).toEqual(['pending', 'confirmed']);
    expect(parsed.items[0]?.startsAt).toBe(at(date, 10 * 60).toISOString());
    // Администратору нужен рабочий номер, а не маска.
    expect(parsed.items[0]?.clientPhone).toBe(fakeClient.phone);
    // Почты клиента в ответах нет.
    expect(response.body).not.toContain(fakeClient.email);
  });

  it('без cookie сотрудника — 401, с клиентской cookie — тоже 401', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: `/admin/appointments?date=${salonDatePlus(1)}`,
      headers: headers(),
    });
    expect(anonymous.statusCode).toBe(401);
    expect(apiErrorSchema.parse(anonymous.json()).error.code).toBe('unauthorized');

    const clientId = await fixture.client(`client-${randomUUID()}@example.invalid`);
    const clientCookie = `hl_session=${await fixture.session(clientId)}`;
    const withClientCookie = await app.inject({
      method: 'GET',
      url: `/admin/appointments?date=${salonDatePlus(1)}`,
      headers: { ...headers(), cookie: clientCookie },
    });
    expect(withClientCookie.statusCode).toBe(401);
    expect(apiErrorSchema.parse(withClientCookie.json()).error.code).toBe('unauthorized');
  });

  it('неверная дата — 400 validation_error', async () => {
    const cookie = await loginAsStaff();

    for (const query of ['date=2030-02-30', 'date=сегодня', '']) {
      const response = await app.inject({
        method: 'GET',
        url: `/admin/appointments?${query}`,
        headers: { ...headers(), cookie },
      });
      expect(response.statusCode).toBe(400);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe('validation_error');
    }
  });
});

describe('переходы статусов записи', () => {
  it('подтверждение идемпотентно и не сдвигает updatedAt на повторе', async () => {
    const cookie = await loginAsStaff();
    const { masterId, serviceId } = await setupCatalog();
    const id = await createAppointment(masterId, serviceId, at(salonDatePlus(2), 12 * 60));

    const confirmed = await app.inject({
      method: 'POST',
      url: `/admin/appointments/${id}/confirm`,
      headers: { ...headers(), cookie },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(adminAppointmentResponseSchema.parse(confirmed.json()).booking.status).toBe('confirmed');

    const stored = await readAppointment(id);
    expect(stored.status).toBe('confirmed');

    const repeated = await app.inject({
      method: 'POST',
      url: `/admin/appointments/${id}/confirm`,
      headers: { ...headers(), cookie },
    });
    expect(repeated.statusCode).toBe(200);
    expect(adminAppointmentResponseSchema.parse(repeated.json()).booking.status).toBe('confirmed');
    // Повтор ничего не переписал: отметка обновления та же.
    expect((await readAppointment(id)).updatedAt).toEqual(stored.updatedAt);
  });

  it('complete и no-show переводят активную запись, повтор — 200', async () => {
    const cookie = await loginAsStaff();
    const { masterId, serviceId } = await setupCatalog();
    const date = salonDatePlus(2);
    const completedId = await createAppointment(masterId, serviceId, at(date, 10 * 60), {
      status: 'confirmed',
    });
    const noShowId = await createAppointment(masterId, serviceId, at(date, 11 * 60));

    const completed = await app.inject({
      method: 'POST',
      url: `/admin/appointments/${completedId}/complete`,
      headers: { ...headers(), cookie },
    });
    expect(completed.statusCode).toBe(200);
    expect(adminAppointmentResponseSchema.parse(completed.json()).booking.status).toBe('completed');

    const noShow = await app.inject({
      method: 'POST',
      url: `/admin/appointments/${noShowId}/no-show`,
      headers: { ...headers(), cookie },
    });
    expect(noShow.statusCode).toBe(200);
    expect(adminAppointmentResponseSchema.parse(noShow.json()).booking.status).toBe('no_show');

    const repeated = await app.inject({
      method: 'POST',
      url: `/admin/appointments/${noShowId}/no-show`,
      headers: { ...headers(), cookie },
    });
    expect(repeated.statusCode).toBe(200);
    expect((await readAppointment(noShowId)).status).toBe('no_show');
  });

  it('терминальные статусы не меняются: 409 conflict', async () => {
    // Роль `admin`: в наборе есть отмена салоном, а она менеджеру запрещена (#252).
    const cookie = await loginAsStaff('admin');
    const { masterId, serviceId } = await setupCatalog();
    const date = salonDatePlus(2);
    const completedId = await createAppointment(masterId, serviceId, at(date, 9 * 60), {
      status: 'completed',
    });
    const noShowId = await createAppointment(masterId, serviceId, at(date, 10 * 60), {
      status: 'no_show',
    });

    const actions: Array<{ id: string; action: string; payload?: { reason: string } }> = [
      { id: completedId, action: 'confirm' },
      { id: completedId, action: 'no-show' },
      { id: completedId, action: 'cancel', payload: { reason: 'мастер заболел' } },
      { id: noShowId, action: 'confirm' },
      { id: noShowId, action: 'complete' },
    ];

    for (const { id, action, payload } of actions) {
      const response = await app.inject({
        method: 'POST',
        url: `/admin/appointments/${id}/${action}`,
        headers: { ...headers(), cookie },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(response.statusCode).toBe(409);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe('conflict');
    }

    // Статусы и outbox после отказов не изменились.
    expect((await readAppointment(completedId)).status).toBe('completed');
    expect((await readAppointment(noShowId)).status).toBe('no_show');
    expect(await readOutbox(completedId)).toEqual([]);
  });

  it('неизвестная запись — 404 not_found', async () => {
    const cookie = await loginAsStaff();

    const response = await app.inject({
      method: 'POST',
      url: `/admin/appointments/${randomUUID()}/confirm`,
      headers: { ...headers(), cookie },
    });

    expect(response.statusCode).toBe(404);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('not_found');
  });

  it('без cookie сотрудника действия недоступны', async () => {
    const { masterId, serviceId } = await setupCatalog();
    const id = await createAppointment(masterId, serviceId, at(salonDatePlus(2), 12 * 60));

    const response = await app.inject({
      method: 'POST',
      url: `/admin/appointments/${id}/confirm`,
      headers: headers(),
    });

    expect(response.statusCode).toBe(401);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('unauthorized');
    expect((await readAppointment(id)).status).toBe('pending');
  });
});

describe('POST /admin/appointments/:id/cancel', () => {
  it('пишет причину салона, снимает подтверждение и ставит письмо об отмене', async () => {
    const cookie = await loginAsStaff('admin');
    const { masterId, serviceId } = await setupCatalog();
    const id = await createAppointment(masterId, serviceId, at(salonDatePlus(2), 14 * 60), {
      status: 'confirmed',
    });
    // Подтверждение ещё не отправлено: оно должно быть подавлено отменой.
    await db.outboxMessage.create({
      data: { type: BOOKING_CONFIRMATION_TYPE, appointmentId: id, payload: {} },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/admin/appointments/${id}/cancel`,
      headers: { ...headers(), cookie },
      payload: { reason: '  мастер заболел  ' },
    });

    expect(response.statusCode).toBe(200);
    const parsed = adminAppointmentResponseSchema.parse(response.json());
    expect(parsed.booking.status).toBe('cancelled');

    // Причина отличима от клиентской отмены: по префиксу видно, что отменил салон.
    const stored = await readAppointment(id);
    expect(stored.status).toBe('cancelled');
    expect(stored.cancelReason).toBe('cancelled_by_salon: мастер заболел');

    const outbox = await readOutbox(id);
    expect(outbox).toEqual([
      { type: BOOKING_CONFIRMATION_TYPE, status: 'suppressed', lastError: 'cancelled' },
      { type: BOOKING_CANCELLATION_TYPE, status: 'pending', lastError: null },
    ]);
    // Письмо об отмене — со снимком записи и почтой клиента (ПДн только в БД/письме).
    const cancellation = await db.outboxMessage.findFirstOrThrow({
      where: { appointmentId: id, type: BOOKING_CANCELLATION_TYPE },
      select: { payload: true },
    });
    expect(cancellation.payload).toMatchObject({
      clientEmail: fakeClient.email,
      serviceName: 'Стрижка',
      masterName: 'Тестовый Мастер',
    });

    // Повтор: 200, причина и updatedAt не перезаписаны, второго письма нет.
    const repeated = await app.inject({
      method: 'POST',
      url: `/admin/appointments/${id}/cancel`,
      headers: { ...headers(), cookie },
      payload: { reason: 'другая причина' },
    });
    expect(repeated.statusCode).toBe(200);
    const afterRepeat = await readAppointment(id);
    expect(afterRepeat.cancelReason).toBe('cancelled_by_salon: мастер заболел');
    expect(afterRepeat.updatedAt).toEqual(stored.updatedAt);
    expect(
      await db.outboxMessage.count({
        where: { appointmentId: id, type: BOOKING_CANCELLATION_TYPE },
      }),
    ).toBe(1);
  });

  it('отмену клиента не перезаписывает: 409 и прежняя причина', async () => {
    const cookie = await loginAsStaff('admin');
    const { masterId, serviceId } = await setupCatalog();
    const id = await createAppointment(masterId, serviceId, at(salonDatePlus(2), 15 * 60), {
      status: 'cancelled',
    });
    await db.appointment.update({
      where: { id },
      data: { cancelReason: 'cancelled_by_client' },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/admin/appointments/${id}/cancel`,
      headers: { ...headers(), cookie },
      payload: { reason: 'мастер заболел' },
    });

    expect(response.statusCode).toBe(409);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('conflict');
    const stored = await readAppointment(id);
    expect(stored.cancelReason).toBe('cancelled_by_client');
    expect(await readOutbox(id)).toEqual([]);
  });

  it('без почты клиента отмена проходит, письма нет', async () => {
    const cookie = await loginAsStaff('admin');
    const { masterId, serviceId } = await setupCatalog();
    const id = await createAppointment(masterId, serviceId, at(salonDatePlus(2), 16 * 60), {
      clientEmail: null,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/admin/appointments/${id}/cancel`,
      headers: { ...headers(), cookie },
      payload: { reason: 'клиент просил перенести' },
    });

    expect(response.statusCode).toBe(200);
    expect((await readAppointment(id)).status).toBe('cancelled');
    expect(await readOutbox(id)).toEqual([]);
  });

  it('пустая причина — 400 validation_error', async () => {
    const cookie = await loginAsStaff('admin');
    const { masterId, serviceId } = await setupCatalog();
    const id = await createAppointment(masterId, serviceId, at(salonDatePlus(2), 17 * 60));

    for (const payload of [{ reason: '' }, { reason: '   ' }, {}, { reason: 'a'.repeat(1001) }]) {
      const response = await app.inject({
        method: 'POST',
        url: `/admin/appointments/${id}/cancel`,
        headers: { ...headers(), cookie },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe('validation_error');
    }
    expect((await readAppointment(id)).status).toBe('pending');
  });
});

describe('матрица ролей админки (#252)', () => {
  it('менеджер ведёт день, но отменить салоном не может: 403 forbidden', async () => {
    const cookie = await loginAsStaff('manager');
    const { masterId, serviceId } = await setupCatalog();
    const date = salonDatePlus(2);
    const id = await createAppointment(masterId, serviceId, at(date, 13 * 60));

    // День и операционные отметки менеджеру доступны: роль ограничивает только отмену.
    const list = await app.inject({
      method: 'GET',
      url: `/admin/appointments?date=${date}`,
      headers: { ...headers(), cookie },
    });
    expect(list.statusCode).toBe(200);

    const cancel = await app.inject({
      method: 'POST',
      url: `/admin/appointments/${id}/cancel`,
      headers: { ...headers(), cookie },
      payload: { reason: 'мастер заболел' },
    });

    expect(cancel.statusCode).toBe(403);
    expect(apiErrorSchema.parse(cancel.json()).error.code).toBe('forbidden');
    // Роль проверяется до записи: статус не тронут, письма клиенту нет.
    expect((await readAppointment(id)).status).toBe('pending');
    expect(await readOutbox(id)).toEqual([]);
  });
});
