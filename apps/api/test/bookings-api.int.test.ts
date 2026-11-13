import {
  apiErrorSchema,
  bookingResponseSchema,
  slotsResponseSchema,
  type Slot,
} from '@hair-lab/contracts';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app/build-server';
import { env } from '../src/shared/config/env';
import { createFixture, createTestDb, fakeClient } from './db/helpers';

/**
 * Онлайн-запись через HTTP: `GET /slots` и `POST /bookings` на реальной БД.
 * Проверяет свободные слоты, идемпотентность, гонку за один слот и отсутствие ПДн в ответах.
 * Все данные вымышленные; даты считаются от текущего момента в TZ салона.
 */
const db = createTestDb();
const fixture = createFixture(db);
const app = await buildServer();

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

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

let keyCounter = 0;

/** Уникальный ключ идемпотентности в рамках прогона (в БД он уникален). */
function nextKey(): string {
  keyCounter += 1;
  return `test-idempotency-key-${keyCounter}`;
}

/** Мастер с услугой и сменой 09:00–12:00 в TZ салона на дату через N дней. */
async function setupSalon(options: { daysAhead?: number; durationMin?: number } = {}) {
  const date = salonDatePlus(options.daysAhead ?? 3);
  const masterId = await fixture.master();
  const serviceId = await fixture.service({ durationMin: options.durationMin ?? 60 });
  await fixture.link(masterId, serviceId);
  await fixture.workingHours(masterId, dayOfWeekOf(date), 9 * 60, 12 * 60);
  return { masterId, serviceId, date };
}

async function getSlots(query: { serviceId: string; masterId?: string; date: string }) {
  const search = new URLSearchParams({ serviceId: query.serviceId, date: query.date });
  if (query.masterId !== undefined) search.set('masterId', query.masterId);

  const response = await app.inject({ method: 'GET', url: `/slots?${search.toString()}` });
  return { statusCode: response.statusCode, body: response.json() as unknown };
}

function bookingBody(params: {
  masterId: string;
  serviceId: string;
  startsAt: string;
  idempotencyKey: string;
}) {
  return {
    ...params,
    clientName: fakeClient.name,
    clientPhone: fakeClient.phone,
    clientEmail: fakeClient.email,
  };
}

async function postBooking(body: object) {
  const response = await app.inject({ method: 'POST', url: '/bookings', payload: body });
  return {
    statusCode: response.statusCode,
    body: response.json() as unknown,
    raw: response.body,
  };
}

function slotStarts(body: unknown): string[] {
  return slotsResponseSchema.parse(body).items.map((slot) => slot.startsAt);
}

function errorCode(body: unknown): string {
  return apiErrorSchema.parse(body).error.code;
}

describe('GET /slots', () => {
  it('отдаёт свободные слоты смены с шагом 15 минут и без занятых', async () => {
    const { masterId, serviceId, date } = await setupSalon();

    const { statusCode, body } = await getSlots({ serviceId, date });
    expect(statusCode).toBe(200);

    const slots = slotsResponseSchema.parse(body).items;
    // Смена 3 часа, приём 1 час, шаг 15 минут: 9 вариантов начала.
    expect(slots).toHaveLength(9);
    expect(new Set(slots.map((slot) => slot.masterId))).toEqual(new Set([masterId]));
    for (const slot of slots) {
      expect(slot.startsAt.endsWith('Z')).toBe(true);
      expect(new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime()).toBe(
        60 * MINUTE_MS,
      );
    }

    const taken = slots[0] as Slot;
    await fixture.appointment(masterId, serviceId, taken.startsAt, taken.endsAt);

    const afterBooking = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body);
    const starts = afterBooking.items.map((slot) => slot.startsAt);
    // Приём на час блокирует все начала внутри себя, а не только выбранное.
    expect(starts).not.toContain(taken.startsAt);
    expect(starts).toHaveLength(5);
    expect(starts).toContain(slots.at(-1)?.startsAt);
  });

  it('учитывает исключение расписания и фильтр по мастеру', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const anotherMasterId = await fixture.master('Второй Мастер');
    await fixture.link(anotherMasterId, serviceId);
    await fixture.workingHours(anotherMasterId, dayOfWeekOf(date), 9 * 60, 12 * 60);

    const allSlots = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body).items;
    const victim = allSlots[0] as Slot;
    await fixture.exception(
      masterId,
      victim.startsAt,
      new Date(new Date(victim.startsAt).getTime() + 2 * 60 * MINUTE_MS).toISOString(),
    );

    const ofMaster = slotsResponseSchema.parse(
      (await getSlots({ serviceId, date, masterId })).body,
    ).items;
    expect(ofMaster.every((slot) => slot.masterId === masterId)).toBe(true);
    expect(ofMaster.map((slot) => slot.startsAt)).not.toContain(victim.startsAt);

    // У второго мастера исключения нет: то же время у него остаётся свободным.
    const ofAnother = slotsResponseSchema.parse(
      (await getSlots({ serviceId, date, masterId: anotherMasterId })).body,
    ).items;
    expect(ofAnother.every((slot) => slot.masterId === anotherMasterId)).toBe(true);
    expect(ofAnother.map((slot) => slot.startsAt)).toContain(victim.startsAt);
    expect(slotStarts((await getSlots({ serviceId, date })).body)).toContain(victim.startsAt);
  });

  it('не отдаёт слоты в день без рабочих часов и для отключённой услуги', async () => {
    const { serviceId, date } = await setupSalon();
    const dayOff = salonDatePlus(4);

    expect(slotStarts((await getSlots({ serviceId, date: dayOff })).body)).toEqual([]);

    await db.service.update({ where: { id: serviceId }, data: { isActive: false } });
    expect(slotStarts((await getSlots({ serviceId, date })).body)).toEqual([]);
  });

  it('отдаёт слот снова после отмены записи (EXCLUDE не держит отменённые)', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slots = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body).items;
    const slot = slots[0] as Slot;

    const appointmentId = await fixture.appointment(
      masterId,
      serviceId,
      slot.startsAt,
      slot.endsAt,
    );
    expect(slotStarts((await getSlots({ serviceId, date })).body)).not.toContain(slot.startsAt);

    await db.appointment.update({ where: { id: appointmentId }, data: { status: 'cancelled' } });

    expect(slotStarts((await getSlots({ serviceId, date })).body)).toContain(slot.startsAt);
  });

  it('отклоняет запрос без услуги и с битой датой', async () => {
    const missingService = await app.inject({ method: 'GET', url: '/slots?date=2030-03-04' });
    const brokenDate = await app.inject({
      method: 'GET',
      url: '/slots?serviceId=00000000-0000-4000-8000-000000000000&date=04.03.2030',
    });

    expect(missingService.statusCode).toBe(400);
    expect(errorCode(missingService.json())).toBe('validation_error');
    expect(brokenDate.statusCode).toBe(400);
    expect(errorCode(brokenDate.json())).toBe('validation_error');
  });
});

describe('POST /bookings', () => {
  it('создаёт запись со снимками услуги и не возвращает контакты клиента', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body)
      .items[0] as Slot;

    const { statusCode, body, raw } = await postBooking(
      bookingBody({ masterId, serviceId, startsAt: slot.startsAt, idempotencyKey: nextKey() }),
    );

    expect(statusCode).toBe(201);
    const { booking } = bookingResponseSchema.parse(body);
    expect(booking.masterId).toBe(masterId);
    expect(booking.serviceId).toBe(serviceId);
    expect(booking.startsAt).toBe(slot.startsAt);
    expect(booking.endsAt).toBe(slot.endsAt);
    expect(booking.status).toBe('pending');
    expect(booking.price).toEqual({ amountMinor: 350_000, currency: 'RUB' });
    expect(booking.durationMin).toBe(60);
    expect(booking.clientName).toBe(fakeClient.name);

    // ПДн: ни телефона, ни почты в ответе нет.
    expect(raw).not.toContain(fakeClient.phone);
    expect(raw).not.toContain(fakeClient.email);
    const stored = await db.appointment.findFirst({
      where: { masterId },
      select: { clientId: true },
    });
    expect(stored?.clientId).toBeNull();
  });

  it('привязывает запись к аккаунту при валидной сессии', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body)
      .items[0] as Slot;
    const clientId = await fixture.client();
    const token = await fixture.session(clientId);
    const response = await app.inject({
      method: 'POST',
      url: '/bookings',
      headers: { cookie: `hl_session=${token}` },
      payload: bookingBody({
        masterId,
        serviceId,
        startsAt: slot.startsAt,
        idempotencyKey: nextKey(),
      }),
    });

    expect(response.statusCode).toBe(201);
    const stored = await db.appointment.findFirst({
      where: { masterId },
      select: { clientId: true },
    });
    expect(stored?.clientId).toBe(clientId);
  });

  it('приводит телефон к E.164 в БД и отдаёт только маску номера', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body)
      .items[0] as Slot;

    const { statusCode, body, raw } = await postBooking({
      ...bookingBody({ masterId, serviceId, startsAt: slot.startsAt, idempotencyKey: nextKey() }),
      clientPhone: '8 (912) 345-67-89',
    });

    expect(statusCode).toBe(201);
    expect(bookingResponseSchema.parse(body).booking.clientPhoneMasked).toBe('+7 (***) ***-**-89');

    // ПДн: в ответе только маска, полного номера в любом написании нет.
    expect(raw).not.toContain('+79123456789');
    expect(raw).not.toContain('9123456789');
    expect(raw).not.toContain('345-67-89');

    const stored = await db.appointment.findFirst({
      where: { masterId },
      select: { clientPhone: true },
    });
    expect(stored?.clientPhone).toBe('+79123456789');
  });

  it('принимает международный номер: 201, в БД E.164, в ответе только маска', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body)
      .items[0] as Slot;

    const { statusCode, body, raw } = await postBooking({
      ...bookingBody({ masterId, serviceId, startsAt: slot.startsAt, idempotencyKey: nextKey() }),
      clientPhone: '+1 202 555 0143',
    });

    expect(statusCode).toBe(201);
    expect(bookingResponseSchema.parse(body).booking.clientPhoneMasked).toBe('+1 ********43');

    // ПДн: в ответе только маска, полного номера в любом написании нет.
    expect(raw).not.toContain('+12025550143');
    expect(raw).not.toContain('2025550143');
    expect(raw).not.toContain('202 555 0143');

    const stored = await db.appointment.findFirst({
      where: { masterId },
      select: { clientPhone: true },
    });
    expect(stored?.clientPhone).toBe('+12025550143');
  });

  it('отклоняет не-телефон — 400 validation_error без значения в ответе', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body)
      .items[0] as Slot;

    const cases = [
      { phone: '1234567', secret: '1234567' },
      { phone: '8 (912) 345-67-8', secret: '912345678' },
      { phone: '+1 202 555 01', secret: '20255501' },
      { phone: 'не телефон', secret: 'не телефон' },
    ];

    for (const { phone, secret } of cases) {
      const response = await postBooking({
        ...bookingBody({ masterId, serviceId, startsAt: slot.startsAt, idempotencyKey: nextKey() }),
        clientPhone: phone,
      });

      expect(response.statusCode).toBe(400);
      expect(errorCode(response.body)).toBe('validation_error');
      // ПДн: введённое значение не повторяется в теле ошибки ни в каком виде.
      expect(response.raw).not.toContain(secret);
    }

    expect(await db.appointment.count({ where: { masterId } })).toBe(0);
  });

  it('отдаёт ошибку поля в details и не повторяет введённый телефон в ответе', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body)
      .items[0] as Slot;

    const { statusCode, body, raw } = await postBooking({
      ...bookingBody({ masterId, serviceId, startsAt: slot.startsAt, idempotencyKey: nextKey() }),
      clientPhone: 'abc',
    });

    expect(statusCode).toBe(400);
    expect(errorCode(body)).toBe('validation_error');
    // Форма показывает ошибку рядом с полем: путь совпадает с именем поля ввода.
    const details = apiErrorSchema.parse(body).error.details ?? [];
    expect(details[0]?.path).toBe('clientPhone');
    expect(details[0]?.message).toBeTruthy();
    // ПДн: введённое значение не попадает даже в текст ошибки поля.
    expect(raw).not.toContain('abc');
    expect(await db.appointment.count({ where: { masterId } })).toBe(0);
  });

  it('повтор с тем же ключом возвращает 200 и ту же запись', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body)
      .items[0] as Slot;
    const body = bookingBody({
      masterId,
      serviceId,
      startsAt: slot.startsAt,
      idempotencyKey: nextKey(),
    });

    const first = await postBooking(body);
    const second = await postBooking({ ...body, clientName: 'Другое Имя Клиента' });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(bookingResponseSchema.parse(second.body).booking.id).toBe(
      bookingResponseSchema.parse(first.body).booking.id,
    );
    expect(await db.appointment.count({ where: { masterId } })).toBe(1);
  });

  it('тот же ключ с другим временем — 409 conflict', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slots = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body).items;
    const idempotencyKey = nextKey();
    const first = await postBooking(
      bookingBody({ masterId, serviceId, startsAt: (slots[0] as Slot).startsAt, idempotencyKey }),
    );

    const second = await postBooking(
      bookingBody({ masterId, serviceId, startsAt: (slots[1] as Slot).startsAt, idempotencyKey }),
    );

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(errorCode(second.body)).toBe('conflict');
    expect(await db.appointment.count({ where: { masterId } })).toBe(1);
  });

  it('занятый слот — 409 slot_unavailable', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body)
      .items[0] as Slot;
    await fixture.appointment(masterId, serviceId, slot.startsAt, slot.endsAt);

    const response = await postBooking(
      bookingBody({ masterId, serviceId, startsAt: slot.startsAt, idempotencyKey: nextKey() }),
    );

    expect(response.statusCode).toBe(409);
    expect(errorCode(response.body)).toBe('slot_unavailable');
    expect(await db.appointment.count({ where: { masterId } })).toBe(1);
  });

  it('нерабочее время — 409 slot_unavailable', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body)
      .items[0] as Slot;
    const dayOffStartsAt = new Date(new Date(slot.startsAt).getTime() + DAY_MS).toISOString();

    const response = await postBooking(
      bookingBody({
        masterId,
        serviceId,
        startsAt: dayOffStartsAt,
        idempotencyKey: nextKey(),
      }),
    );

    expect(response.statusCode).toBe(409);
    expect(errorCode(response.body)).toBe('slot_unavailable');
    expect(await db.appointment.count({ where: { masterId } })).toBe(0);
  });

  it('гонка двух запросов на один слот: ровно один 201, второй 409 slot_unavailable', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body)
      .items[0] as Slot;

    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/bookings',
        payload: bookingBody({
          masterId,
          serviceId,
          startsAt: slot.startsAt,
          idempotencyKey: nextKey(),
        }),
      }),
      app.inject({
        method: 'POST',
        url: '/bookings',
        payload: bookingBody({
          masterId,
          serviceId,
          startsAt: slot.startsAt,
          idempotencyKey: nextKey(),
        }),
      }),
    ]);

    const created = responses.filter((response) => response.statusCode === 201);
    const rejected = responses.filter((response) => response.statusCode === 409);

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(errorCode(rejected[0]?.json())).toBe('slot_unavailable');
    expect(await db.appointment.count({ where: { masterId } })).toBe(1);
  });

  it('мастер не оказывает услугу — 404 not_found, записи нет', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body)
      .items[0] as Slot;
    // Связь m-n удаляется после получения слота: время остаётся рабочим, но услугу мастер не оказывает.
    await db.masterService.delete({ where: { masterId_serviceId: { masterId, serviceId } } });

    const response = await postBooking(
      bookingBody({ masterId, serviceId, startsAt: slot.startsAt, idempotencyKey: nextKey() }),
    );

    expect(response.statusCode).toBe(404);
    expect(errorCode(response.body)).toBe('not_found');
    expect(await db.appointment.count({ where: { masterId } })).toBe(0);
  });

  it('неактивный мастер — 404 not_found, записи нет', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body)
      .items[0] as Slot;
    await db.master.update({ where: { id: masterId }, data: { isActive: false } });

    const response = await postBooking(
      bookingBody({ masterId, serviceId, startsAt: slot.startsAt, idempotencyKey: nextKey() }),
    );

    expect(response.statusCode).toBe(404);
    expect(errorCode(response.body)).toBe('not_found');
    expect(await db.appointment.count({ where: { masterId } })).toBe(0);
  });

  it('неизвестный мастер — 404 not_found, а не 500', async () => {
    const { serviceId, date } = await setupSalon();
    const slot = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body)
      .items[0] as Slot;

    const response = await postBooking(
      bookingBody({
        masterId: '00000000-0000-4000-8000-000000000000',
        serviceId,
        startsAt: slot.startsAt,
        idempotencyKey: nextKey(),
      }),
    );

    expect(response.statusCode).toBe(404);
    expect(errorCode(response.body)).toBe('not_found');
    expect(await db.appointment.count({ where: { serviceId } })).toBe(0);
  });

  it('отклоняет тело без телефона и с неизвестной услугой', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = slotsResponseSchema.parse((await getSlots({ serviceId, date })).body)
      .items[0] as Slot;

    const withoutPhone = await postBooking({
      masterId,
      serviceId,
      startsAt: slot.startsAt,
      clientName: fakeClient.name,
      idempotencyKey: nextKey(),
    });
    expect(withoutPhone.statusCode).toBe(400);
    expect(errorCode(withoutPhone.body)).toBe('validation_error');

    const unknownService = await postBooking(
      bookingBody({
        masterId,
        serviceId: '00000000-0000-4000-8000-000000000000',
        startsAt: slot.startsAt,
        idempotencyKey: nextKey(),
      }),
    );
    expect(unknownService.statusCode).toBe(404);
    expect(errorCode(unknownService.body)).toBe('not_found');
  });
});
