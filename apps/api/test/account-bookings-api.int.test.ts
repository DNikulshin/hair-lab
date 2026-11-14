import {
  accountBookingResponseSchema,
  accountBookingsResponseSchema,
  apiErrorSchema,
  slotsResponseSchema,
  type Slot,
} from '@hair-lab/contracts';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app/build-server';
import { CANCEL_REASON } from '../src/features/bookings';
import { env } from '../src/shared/config/env';
import { appointmentData, createFixture, createTestDb, fakeClient } from './db/helpers';

/**
 * Кабинет клиента через HTTP: `GET /account/bookings` и `DELETE /account/bookings/:id`
 * на реальной БД.
 *
 * Проверяет изоляцию записей (только свои, гостевые не видны), деление на предстоящие
 * и прошлые, правило отмены (два часа, статусы), идемпотентность повтора, возврат слота
 * в `GET /slots` после отмены, курсорную пагинацию и отсутствие ПДн в ответах.
 * Все данные вымышленные; время считается от текущего момента.
 */
const db = createTestDb();
const fixture = createFixture(db);
const app = await buildServer();

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

type Status = 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';

afterEach(async () => {
  await fixture.cleanup();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

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

/** День недели календарной даты (0 — воскресенье). */
function dayOfWeekOf(date: string): number {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Момент через `ms` от текущего: записи создаются в обход расписания. */
function fromNow(ms: number): Date {
  return new Date(Date.now() + ms);
}

/** Мастер, услуга и клиент с активной сессией: у каждого теста свои. */
async function setup() {
  const masterId = await fixture.master();
  const serviceId = await fixture.service();
  await fixture.link(masterId, serviceId);
  const clientId = await fixture.client();
  const cookie = `hl_session=${await fixture.session(clientId)}`;
  return { masterId, serviceId, clientId, cookie };
}

interface BookingOptions {
  status?: Status;
}

/**
 * Запись в БД в обход HTTP: так проверяются любые статусы и времена.
 * Интервал — час от `startsAt`; пересечений у одного мастера тест не создаёт.
 */
async function addBooking(
  masterId: string,
  serviceId: string,
  startsAt: Date,
  clientId: string | null,
  options: BookingOptions = {},
) {
  const endsAt = new Date(startsAt.getTime() + 60 * MINUTE_MS);
  return db.appointment.create({
    data: {
      ...appointmentData(masterId, serviceId, startsAt.toISOString(), endsAt.toISOString()),
      clientId,
      ...(options.status === undefined ? {} : { status: options.status }),
    },
  });
}

async function listBookings(
  cookie: string | undefined,
  query: { scope?: 'upcoming' | 'past'; limit?: number; cursor?: string } = {},
) {
  const search = new URLSearchParams();
  if (query.scope !== undefined) search.set('scope', query.scope);
  if (query.limit !== undefined) search.set('limit', String(query.limit));
  if (query.cursor !== undefined) search.set('cursor', query.cursor);

  const response = await app.inject({
    method: 'GET',
    url: `/account/bookings?${search.toString()}`,
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
  return { statusCode: response.statusCode, body: response.json() as unknown, raw: response.body };
}

async function cancelBooking(cookie: string | undefined, id: string) {
  const response = await app.inject({
    method: 'DELETE',
    url: `/account/bookings/${id}`,
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });
  return { statusCode: response.statusCode, body: response.json() as unknown, raw: response.body };
}

function errorCode(body: unknown): string {
  return apiErrorSchema.parse(body).error.code;
}

async function getSlots(serviceId: string, date: string): Promise<Slot[]> {
  const search = new URLSearchParams({ serviceId, date });
  const response = await app.inject({ method: 'GET', url: `/slots?${search.toString()}` });
  return slotsResponseSchema.parse(response.json()).items;
}

describe('GET /account/bookings', () => {
  it('без сессии — 401 unauthorized', async () => {
    const listing = await listBookings(undefined);
    expect(listing.statusCode).toBe(401);
    expect(errorCode(listing.body)).toBe('unauthorized');

    const unknown = await cancelBooking(undefined, '00000000-0000-4000-8000-0000000000aa');
    expect(unknown.statusCode).toBe(401);
    expect(errorCode(unknown.body)).toBe('unauthorized');
  });

  it('показывает только свои записи: чужая и гостевая не видны', async () => {
    const { masterId, serviceId, clientId, cookie } = await setup();
    const own = await addBooking(masterId, serviceId, fromNow(5 * DAY_MS), clientId);
    const foreignClientId = await fixture.client();
    const foreign = await addBooking(masterId, serviceId, fromNow(6 * DAY_MS), foreignClientId);
    const guest = await addBooking(masterId, serviceId, fromNow(7 * DAY_MS), null);

    const listing = await listBookings(cookie);

    expect(listing.statusCode).toBe(200);
    const body = accountBookingsResponseSchema.parse(listing.body);
    expect(body.items.map((item) => item.id)).toEqual([own.id]);
    expect(body.items.map((item) => item.id)).not.toContain(foreign.id);
    expect(body.items.map((item) => item.id)).not.toContain(guest.id);
    expect(body.nextCursor).toBeNull();
  });

  it('делит записи на предстоящие и прошлые по времени и статусу', async () => {
    const { masterId, serviceId, clientId, cookie } = await setup();
    const later = await addBooking(masterId, serviceId, fromNow(6 * DAY_MS), clientId, {
      status: 'confirmed',
    });
    const sooner = await addBooking(masterId, serviceId, fromNow(5 * DAY_MS), clientId, {
      status: 'pending',
    });
    const cancelled = await addBooking(masterId, serviceId, fromNow(7 * DAY_MS), clientId, {
      status: 'cancelled',
    });
    const completed = await addBooking(masterId, serviceId, fromNow(8 * DAY_MS), clientId, {
      status: 'completed',
    });
    const noShow = await addBooking(masterId, serviceId, fromNow(9 * DAY_MS), clientId, {
      status: 'no_show',
    });
    const past = await addBooking(masterId, serviceId, fromNow(-2 * DAY_MS), clientId);

    const upcoming = accountBookingsResponseSchema.parse((await listBookings(cookie)).body);
    expect(upcoming.items.map((item) => item.id)).toEqual([sooner.id, later.id]);
    expect(upcoming.items.map((item) => item.status)).toEqual(['pending', 'confirmed']);
    // До начала больше двух часов: обе записи можно отменить.
    expect(upcoming.items.every((item) => item.cancellable)).toBe(true);

    const history = accountBookingsResponseSchema.parse(
      (await listBookings(cookie, { scope: 'past' })).body,
    );
    // По убыванию времени начала: дальние сначала.
    expect(history.items.map((item) => item.id)).toEqual([
      noShow.id,
      completed.id,
      cancelled.id,
      past.id,
    ]);
    expect(history.items.every((item) => item.cancellable === false)).toBe(true);
  });

  it('в ответе только маска телефона: полного номера и почты нет', async () => {
    const { masterId, serviceId, clientId, cookie } = await setup();
    await addBooking(masterId, serviceId, fromNow(5 * DAY_MS), clientId);

    const listing = await listBookings(cookie);
    const body = accountBookingsResponseSchema.parse(listing.body);

    expect(body.items[0]?.clientPhoneMasked).toBe('+7 (***) ***-**-00');
    expect(body.items[0]?.clientName).toBe(fakeClient.name);
    expect(body.items[0]?.masterName).toBe('Тестовый Мастер');
    expect(body.items[0]?.serviceName).toBe('Стрижка');
    expect(listing.raw).not.toContain(fakeClient.phone);
    expect(listing.raw).not.toContain('70000000000');
    expect(listing.raw).not.toContain(fakeClient.email);
  });

  it('пагинация: limit и cursor выдают следующие страницы без дублей', async () => {
    const { masterId, serviceId, clientId, cookie } = await setup();
    const first = await addBooking(masterId, serviceId, fromNow(4 * DAY_MS), clientId);
    const second = await addBooking(masterId, serviceId, fromNow(5 * DAY_MS), clientId);
    const third = await addBooking(masterId, serviceId, fromNow(6 * DAY_MS), clientId);

    const page = accountBookingsResponseSchema.parse(
      (await listBookings(cookie, { limit: 2 })).body,
    );
    expect(page.items.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(page.nextCursor).not.toBeNull();

    const next = accountBookingsResponseSchema.parse(
      (await listBookings(cookie, { limit: 2, cursor: page.nextCursor ?? '' })).body,
    );
    expect(next.items.map((item) => item.id)).toEqual([third.id]);
    expect(next.nextCursor).toBeNull();
  });

  it('пагинация прошлых записей: курсор не теряет фильтр scope=past', async () => {
    const { masterId, serviceId, clientId, cookie } = await setup();
    const cancelled = await addBooking(masterId, serviceId, fromNow(3 * DAY_MS), clientId, {
      status: 'cancelled',
    });
    const upcoming = await addBooking(masterId, serviceId, fromNow(2 * DAY_MS), clientId, {
      status: 'confirmed',
    });

    // Сценарий ревью: на двух записях первая страница «прошлых» уже верна, но продолжать
    // нечем — `limit + 1` не находит лишних строк, поэтому `nextCursor = null`.
    const only = accountBookingsResponseSchema.parse(
      (await listBookings(cookie, { scope: 'past', limit: 1 })).body,
    );
    expect(only.items.map((item) => item.id)).toEqual([cancelled.id]);
    expect(only.nextCursor).toBeNull();

    // Вторая «прошлая» запись нужна, чтобы появился `nextCursor` и вторая страница читалась.
    const past = await addBooking(masterId, serviceId, fromNow(-2 * DAY_MS), clientId);

    const firstPage = accountBookingsResponseSchema.parse(
      (await listBookings(cookie, { scope: 'past', limit: 1 })).body,
    );
    expect(firstPage.items.map((item) => item.id)).toEqual([cancelled.id]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = accountBookingsResponseSchema.parse(
      (await listBookings(cookie, { scope: 'past', limit: 1, cursor: firstPage.nextCursor ?? '' }))
        .body,
    );
    // Вторая страница — только прошлая запись: предстоящая активная не просачивается.
    expect(secondPage.items.map((item) => item.id)).toEqual([past.id]);
    expect(secondPage.items.map((item) => item.id)).not.toContain(upcoming.id);
    expect(secondPage.nextCursor).toBeNull();

    // Обе страницы вместе: элементы не дублируются, предстоящих записей в выдаче нет.
    const ids = [...firstPage.items, ...secondPage.items].map((item) => item.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(upcoming.id);
  });

  it('пагинация предстоящих записей: вторая страница без дублей и без прошедших', async () => {
    const { masterId, serviceId, clientId, cookie } = await setup();
    const past = await addBooking(masterId, serviceId, fromNow(-2 * DAY_MS), clientId);
    const sooner = await addBooking(masterId, serviceId, fromNow(4 * DAY_MS), clientId);
    const later = await addBooking(masterId, serviceId, fromNow(5 * DAY_MS), clientId);

    const firstPage = accountBookingsResponseSchema.parse(
      (await listBookings(cookie, { limit: 1 })).body,
    );
    expect(firstPage.items.map((item) => item.id)).toEqual([sooner.id]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = accountBookingsResponseSchema.parse(
      (await listBookings(cookie, { limit: 1, cursor: firstPage.nextCursor ?? '' })).body,
    );
    expect(secondPage.items.map((item) => item.id)).toEqual([later.id]);
    expect(secondPage.nextCursor).toBeNull();

    const ids = [...firstPage.items, ...secondPage.items].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(past.id);
  });

  it('битые параметры — 400 validation_error, битый курсор тоже', async () => {
    const { cookie } = await setup();

    const badScope = await listBookings(cookie, { scope: 'all' as 'upcoming' });
    expect(badScope.statusCode).toBe(400);
    expect(errorCode(badScope.body)).toBe('validation_error');

    const badCursor = await listBookings(cookie, { cursor: 'not-a-cursor' });
    expect(badCursor.statusCode).toBe(400);
    expect(errorCode(badCursor.body)).toBe('validation_error');
  });
});

describe('DELETE /account/bookings/:id', () => {
  it('отмена в срок: 200, статус cancelled, причина заполнена, слот снова свободен', async () => {
    const { masterId, serviceId, clientId, cookie } = await setup();
    const date = salonDatePlus(3);
    await fixture.workingHours(masterId, dayOfWeekOf(date), 9 * 60, 12 * 60);

    const slots = await getSlots(serviceId, date);
    const slot = slots[0] as Slot;
    const booking = await addBooking(masterId, serviceId, new Date(slot.startsAt), clientId);

    expect((await getSlots(serviceId, date)).map((item) => item.startsAt)).not.toContain(
      slot.startsAt,
    );

    const cancelled = await cancelBooking(cookie, booking.id);

    expect(cancelled.statusCode).toBe(200);
    const body = accountBookingResponseSchema.parse(cancelled.body).booking;
    expect(body.id).toBe(booking.id);
    expect(body.status).toBe('cancelled');
    expect(body.cancellable).toBe(false);
    expect(body.clientPhoneMasked).toBe('+7 (***) ***-**-00');
    // В ответе только маска: полного номера и почты клиента нет.
    expect(cancelled.raw).not.toContain(fakeClient.phone);
    expect(cancelled.raw).not.toContain(fakeClient.email);

    const stored = await db.appointment.findUniqueOrThrow({ where: { id: booking.id } });
    expect(stored.cancelReason).toBe(CANCEL_REASON);

    // EXCLUDE не держит отменённые: время снова доступно к записи.
    expect((await getSlots(serviceId, date)).map((item) => item.startsAt)).toContain(slot.startsAt);
  });

  it('отмена в пределах двух часов — 409, запись остаётся активной', async () => {
    const { masterId, serviceId, clientId, cookie } = await setup();
    const booking = await addBooking(masterId, serviceId, fromNow(60 * MINUTE_MS), clientId);

    const cancelled = await cancelBooking(cookie, booking.id);

    expect(cancelled.statusCode).toBe(409);
    expect(errorCode(cancelled.body)).toBe('conflict');
    const stored = await db.appointment.findUniqueOrThrow({ where: { id: booking.id } });
    expect(stored.status).toBe('pending');
    expect(stored.cancelReason).toBeNull();
  });

  it('прошедшая, completed и no_show — 409', async () => {
    const { masterId, serviceId, clientId, cookie } = await setup();
    const past = await addBooking(masterId, serviceId, fromNow(-2 * DAY_MS), clientId);
    const completed = await addBooking(masterId, serviceId, fromNow(5 * DAY_MS), clientId, {
      status: 'completed',
    });
    const noShow = await addBooking(masterId, serviceId, fromNow(6 * DAY_MS), clientId, {
      status: 'no_show',
    });

    for (const booking of [past, completed, noShow]) {
      const cancelled = await cancelBooking(cookie, booking.id);
      expect(cancelled.statusCode).toBe(409);
      expect(errorCode(cancelled.body)).toBe('conflict');
      const stored = await db.appointment.findUniqueOrThrow({ where: { id: booking.id } });
      expect(stored.status).toBe(booking.status);
      expect(stored.cancelReason).toBeNull();
    }
  });

  it('повторная отмена идемпотентна: 200, причина и updatedAt не перезаписываются', async () => {
    const { masterId, serviceId, clientId, cookie } = await setup();
    const booking = await addBooking(masterId, serviceId, fromNow(5 * DAY_MS), clientId);

    const first = await cancelBooking(cookie, booking.id);
    expect(first.statusCode).toBe(200);

    // Причину меняем вручную: повтор не должен её затирать.
    const before = await db.appointment.update({
      where: { id: booking.id },
      data: { cancelReason: 'cancelled_by_salon' },
    });

    const second = await cancelBooking(cookie, booking.id);
    expect(second.statusCode).toBe(200);
    expect(accountBookingResponseSchema.parse(second.body).booking.status).toBe('cancelled');

    const after = await db.appointment.findUniqueOrThrow({ where: { id: booking.id } });
    expect(after.cancelReason).toBe('cancelled_by_salon');
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  it('чужая запись — 404 и не отменяется; неизвестный id тоже 404', async () => {
    const { masterId, serviceId, cookie } = await setup();
    const foreignClientId = await fixture.client();
    const foreign = await addBooking(masterId, serviceId, fromNow(5 * DAY_MS), foreignClientId);

    const cancelled = await cancelBooking(cookie, foreign.id);
    expect(cancelled.statusCode).toBe(404);
    expect(errorCode(cancelled.body)).toBe('not_found');
    const stored = await db.appointment.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(stored.status).toBe('pending');
    expect(stored.cancelReason).toBeNull();

    const unknown = await cancelBooking(cookie, '00000000-0000-4000-8000-0000000000bb');
    expect(unknown.statusCode).toBe(404);
    expect(errorCode(unknown.body)).toBe('not_found');

    const invalid = await cancelBooking(cookie, 'not-a-uuid');
    expect(invalid.statusCode).toBe(400);
    expect(errorCode(invalid.body)).toBe('validation_error');
  });

  it('гостевую запись нельзя отменить из кабинета чужого клиента', async () => {
    const { masterId, serviceId, cookie } = await setup();
    const guest = await addBooking(masterId, serviceId, fromNow(5 * DAY_MS), null);

    const cancelled = await cancelBooking(cookie, guest.id);
    expect(cancelled.statusCode).toBe(404);
    const stored = await db.appointment.findUniqueOrThrow({ where: { id: guest.id } });
    expect(stored.status).toBe('pending');
  });
});
