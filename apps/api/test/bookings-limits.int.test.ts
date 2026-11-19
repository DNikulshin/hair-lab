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
 * Анти-абьюз холдов на `POST /bookings` (issue #106) на реальной БД.
 *
 * Что проверяется: IP-лимит 10/10 мин (C1), лимит трёх активных будущих записей на телефон (C2),
 * лимит двух ожидающих оплаты холдов (C3), приоритет идемпотентности над лимитами (C4),
 * счёт по нормализованному E.164 и освобождение места (C5), гонка параллельных запросов (C6),
 * два одинаковых ретрая с тем же `idempotencyKey` — 200, а не 429 (C7).
 *
 * Особенности:
 * - IP у каждого запроса задаётся явно (`remoteAddress`): счётчик лимита живёт в памяти
 *   процесса, один адрес на файл упирался бы в 10 запросов из соседних сценариев;
 * - телефоны и ключи идемпотентности уникальны на прогон (dev-БД общая), данные вымышленные;
 * - записи-холды создаются прямо в БД: предмет теста — счёт лимитов, а не платёжный шлюз.
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
  return `limits-int-key-${keyCounter}-${Math.floor(Math.random() * 1e9)}`;
}

/**
 * Вымышленный телефон в E.164 с уникальным номером на прогон: `+7000…` — не действующий
 * диапазон, случайный хвост защищает от остатков прошлых прогонов в общей dev-БД.
 */
function nextPhone(): string {
  return `+7000${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
}

/** Мастер с услугой (60 минут) и сменой 09:00–19:00 в TZ салона на дату через N дней. */
async function setupSalon(options: { daysAhead?: number } = {}) {
  const date = salonDatePlus(options.daysAhead ?? 3);
  const masterId = await fixture.master();
  const serviceId = await fixture.service({ durationMin: 60 });
  await fixture.link(masterId, serviceId);
  await fixture.workingHours(masterId, dayOfWeekOf(date), 9 * 60, 19 * 60);
  return { masterId, serviceId, date };
}

/**
 * Свободные слоты смены без пересечений: шаг слотов 15 минут при 60-минутном приёме,
 * поэтому соседние варианты накладываются, а EXCLUDE-констрейнт не дал бы засеять
 * несколько записей подряд. Оставляем каждый следующий непересекающийся — 9:00, 10:00, …
 */
async function slotsOf(query: { serviceId: string; date: string }): Promise<Slot[]> {
  const search = new URLSearchParams(query);
  const response = await app.inject({ method: 'GET', url: `/slots?${search.toString()}` });
  expect(response.statusCode).toBe(200);
  const result: Slot[] = [];
  for (const slot of slotsResponseSchema.parse(response.json()).items) {
    const previous = result.at(-1);
    if (previous === undefined || new Date(slot.startsAt) >= new Date(previous.endsAt)) {
      result.push(slot);
    }
  }
  return result;
}

function bookingBody(params: {
  masterId: string;
  serviceId: string;
  startsAt: string;
  idempotencyKey: string;
  clientPhone: string;
}) {
  return {
    ...params,
    clientName: fakeClient.name,
    clientEmail: fakeClient.email,
  };
}

/** Запрос записи с явного адреса: IP — ключ счётчика лимита, поэтому задаётся тестом. */
async function postBooking(body: object, remoteAddress: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/bookings',
    payload: body,
    remoteAddress,
  });
  return {
    statusCode: response.statusCode,
    body: response.json() as unknown,
    raw: response.body,
    headers: response.headers,
  };
}

function errorCode(body: unknown): string {
  return apiErrorSchema.parse(body).error.code;
}

/**
 * Запись в БД в обход HTTP: активная запись, холд или закрытая запись прошлого.
 * Интервалы берутся из свободных слотов смены, поэтому EXCLUDE-констрейнт не мешает.
 */
async function seedAppointment(params: {
  masterId: string;
  serviceId: string;
  slot: Slot;
  clientPhone: string;
  status?: 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  paymentDeadlineAt?: Date | null;
}): Promise<string> {
  const created = await db.appointment.create({
    data: {
      masterId: params.masterId,
      serviceId: params.serviceId,
      clientName: fakeClient.name,
      clientPhone: params.clientPhone,
      startsAt: new Date(params.slot.startsAt),
      endsAt: new Date(params.slot.endsAt),
      status: params.status ?? 'confirmed',
      priceKopecks: 350_000,
      durationMin: 60,
      ...(params.paymentDeadlineAt === undefined
        ? {}
        : { paymentDeadlineAt: params.paymentDeadlineAt }),
    },
  });
  return created.id;
}

/** Запись в прошлом: место в лимите активных не держит (начало уже прошло). */
async function seedPastAppointment(params: {
  masterId: string;
  serviceId: string;
  clientPhone: string;
}): Promise<void> {
  const startsAt = new Date(Date.now() - DAY_MS);
  await db.appointment.create({
    data: {
      masterId: params.masterId,
      serviceId: params.serviceId,
      clientName: fakeClient.name,
      clientPhone: params.clientPhone,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * MINUTE_MS),
      status: 'pending',
      priceKopecks: 350_000,
      durationMin: 60,
    },
  });
}

describe('C1: IP-лимит на создание записи', () => {
  it('11-й запрос за 10 минут с одного адреса — 429 rate_limited, первые 10 как раньше', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const [slot] = await slotsOf({ serviceId, date });
    const ip = '10.106.0.1';

    // Первые десять запросов обрабатываются как раньше: один слот — один 201 и девять 409.
    const first: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const response = await postBooking(
        bookingBody({
          masterId,
          serviceId,
          startsAt: (slot as Slot).startsAt,
          idempotencyKey: nextKey(),
          clientPhone: nextPhone(),
        }),
        ip,
      );
      first.push(response.statusCode);
    }
    expect(first[0]).toBe(201);
    expect(first.slice(1)).toEqual(Array.from({ length: 9 }, () => 409));

    const eleventh = await postBooking(
      bookingBody({
        masterId,
        serviceId,
        startsAt: (slot as Slot).startsAt,
        idempotencyKey: nextKey(),
        clientPhone: nextPhone(),
      }),
      ip,
    );

    expect(eleventh.statusCode).toBe(429);
    expect(errorCode(eleventh.body)).toBe('rate_limited');
    // Сработал именно per-route IP-лимит пакета, а не лимит телефона: маршрут объявил 10.
    expect(eleventh.headers['x-ratelimit-limit']).toBe('10');
    expect(await db.appointment.count({ where: { masterId } })).toBe(1);
  });
});

describe('C2: не больше трёх активных будущих записей на телефон', () => {
  it('четвёртая запись — 429 rate_limited, новой строки нет, телефон не попадает в ответ', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slots = await slotsOf({ serviceId, date });
    const phone = nextPhone();

    // Три активные будущие записи: две подтверждённые и одна ожидающая без дедлайна оплаты.
    await seedAppointment({ masterId, serviceId, slot: slots[0] as Slot, clientPhone: phone });
    await seedAppointment({ masterId, serviceId, slot: slots[1] as Slot, clientPhone: phone });
    await seedAppointment({
      masterId,
      serviceId,
      slot: slots[2] as Slot,
      clientPhone: phone,
      status: 'pending',
    });

    const blocked = await postBooking(
      bookingBody({
        masterId,
        serviceId,
        startsAt: (slots[5] as Slot).startsAt,
        idempotencyKey: nextKey(),
        clientPhone: phone,
      }),
      '10.106.0.2',
    );

    expect(blocked.statusCode).toBe(429);
    expect(errorCode(blocked.body)).toBe('rate_limited');
    // ПДн: ни сырого номера, ни его цифр в ответе нет.
    expect(blocked.raw).not.toContain(phone);
    expect(blocked.raw).not.toContain(phone.slice(2));
    expect(await db.appointment.count({ where: { clientPhone: phone } })).toBe(3);
  });
});

describe('C3: не больше двух ожидающих оплаты холдов на телефон', () => {
  it('два холда с будущим дедлайном — 429, а истёкший дедлайн ожиданием не считается', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slots = await slotsOf({ serviceId, date });
    const future = new Date(Date.now() + 15 * MINUTE_MS);

    const phone = nextPhone();
    await seedAppointment({
      masterId,
      serviceId,
      slot: slots[0] as Slot,
      clientPhone: phone,
      status: 'pending',
      paymentDeadlineAt: future,
    });
    await seedAppointment({
      masterId,
      serviceId,
      slot: slots[1] as Slot,
      clientPhone: phone,
      status: 'pending',
      paymentDeadlineAt: future,
    });

    const blocked = await postBooking(
      bookingBody({
        masterId,
        serviceId,
        startsAt: (slots[4] as Slot).startsAt,
        idempotencyKey: nextKey(),
        clientPhone: phone,
      }),
      '10.106.0.3',
    );
    expect(blocked.statusCode).toBe(429);
    expect(errorCode(blocked.body)).toBe('rate_limited');
    expect(await db.appointment.count({ where: { clientPhone: phone } })).toBe(2);

    // Другой телефон: два холда, у которых дедлайн прошёл, — не ожидание оплаты.
    const expiredPhone = nextPhone();
    const past = new Date(Date.now() - MINUTE_MS);
    await seedAppointment({
      masterId,
      serviceId,
      slot: slots[2] as Slot,
      clientPhone: expiredPhone,
      status: 'pending',
      paymentDeadlineAt: past,
    });
    await seedAppointment({
      masterId,
      serviceId,
      slot: slots[3] as Slot,
      clientPhone: expiredPhone,
      status: 'pending',
      paymentDeadlineAt: past,
    });

    const allowed = await postBooking(
      bookingBody({
        masterId,
        serviceId,
        startsAt: (slots[5] as Slot).startsAt,
        idempotencyKey: nextKey(),
        clientPhone: expiredPhone,
      }),
      '10.106.0.4',
    );
    expect(allowed.statusCode).toBe(201);
    expect(await db.appointment.count({ where: { clientPhone: expiredPhone } })).toBe(3);
  });
});

describe('C4: повтор по idempotencyKey лимитами не блокируется', () => {
  it('после исчерпания IP и телефона повтор отдаёт 200 с тем же id, другое время — 409 conflict', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slots = await slotsOf({ serviceId, date });
    const phone = nextPhone();
    const ip = '10.106.0.5';
    const idempotencyKey = nextKey();
    const firstSlot = slots[0] as Slot;

    const created = await postBooking(
      bookingBody({
        masterId,
        serviceId,
        startsAt: firstSlot.startsAt,
        idempotencyKey,
        clientPhone: phone,
      }),
      ip,
    );
    expect(created.statusCode).toBe(201);
    const bookingId = bookingResponseSchema.parse(created.body).booking.id;

    // Лимит телефона исчерпан: к созданной записи добавляются две активные.
    await seedAppointment({ masterId, serviceId, slot: slots[1] as Slot, clientPhone: phone });
    await seedAppointment({ masterId, serviceId, slot: slots[2] as Slot, clientPhone: phone });

    // Лимит IP добирается до 10 запросов: девять попыток на уже занятый слот.
    for (let index = 0; index < 9; index += 1) {
      await postBooking(
        bookingBody({
          masterId,
          serviceId,
          startsAt: firstSlot.startsAt,
          idempotencyKey: nextKey(),
          clientPhone: nextPhone(),
        }),
        ip,
      );
    }

    // Счётчик исчерпан: новый ключ с этого адреса больше не проходит.
    const exhausted = await postBooking(
      bookingBody({
        masterId,
        serviceId,
        startsAt: (slots[3] as Slot).startsAt,
        idempotencyKey: nextKey(),
        clientPhone: nextPhone(),
      }),
      ip,
    );
    expect(exhausted.statusCode).toBe(429);
    expect(errorCode(exhausted.body)).toBe('rate_limited');

    // Повтор того же запроса — 200 и та же запись, хотя лимиты исчерпаны.
    const repeated = await postBooking(
      bookingBody({
        masterId,
        serviceId,
        startsAt: firstSlot.startsAt,
        idempotencyKey,
        clientPhone: phone,
      }),
      ip,
    );
    expect(repeated.statusCode).toBe(200);
    expect(bookingResponseSchema.parse(repeated.body).booking.id).toBe(bookingId);

    // Тот же ключ с другим содержимым — 409 conflict, а не 429.
    const conflict = await postBooking(
      bookingBody({
        masterId,
        serviceId,
        startsAt: (slots[3] as Slot).startsAt,
        idempotencyKey,
        clientPhone: phone,
      }),
      ip,
    );
    expect(conflict.statusCode).toBe(409);
    expect(errorCode(conflict.body)).toBe('conflict');
    expect(await db.appointment.count({ where: { masterId } })).toBe(3);
  });
});

describe('C5: счёт по нормализованному номеру, закрытые записи место освобождают', () => {
  it('разные написания одного номера — один счётчик; отменённая/прошедшая запись не считается', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slots = await slotsOf({ serviceId, date });
    const phone = '+70001234567';
    const ip = '10.106.0.6';

    // Место не держат: отменённая, завершённая, неявка и запись в прошлом.
    await seedAppointment({
      masterId,
      serviceId,
      slot: slots[0] as Slot,
      clientPhone: phone,
      status: 'cancelled',
    });
    await seedAppointment({
      masterId,
      serviceId,
      slot: slots[1] as Slot,
      clientPhone: phone,
      status: 'completed',
    });
    await seedAppointment({
      masterId,
      serviceId,
      slot: slots[2] as Slot,
      clientPhone: phone,
      status: 'no_show',
    });
    await seedPastAppointment({ masterId, serviceId, clientPhone: phone });

    // Номер в другом написании: лимит считается по E.164, а не по введённой строке.
    const created = await postBooking(
      bookingBody({
        masterId,
        serviceId,
        startsAt: (slots[5] as Slot).startsAt,
        idempotencyKey: nextKey(),
        clientPhone: '8 (000) 123-45-67',
      }),
      ip,
    );
    expect(created.statusCode).toBe(201);
    const createdId = bookingResponseSchema.parse(created.body).booking.id;
    const stored = await db.appointment.findUniqueOrThrow({
      where: { id: createdId },
      select: { clientPhone: true },
    });
    expect(stored.clientPhone).toBe(phone);

    // Добираем до трёх активных и упираемся в лимит другим написанием того же номера.
    const secondId = await seedAppointment({
      masterId,
      serviceId,
      slot: slots[6] as Slot,
      clientPhone: phone,
    });
    await seedAppointment({ masterId, serviceId, slot: slots[7] as Slot, clientPhone: phone });

    const blocked = await postBooking(
      bookingBody({
        masterId,
        serviceId,
        startsAt: (slots[8] as Slot).startsAt,
        idempotencyKey: nextKey(),
        clientPhone: '+7 000 123 45 67',
      }),
      ip,
    );
    expect(blocked.statusCode).toBe(429);
    expect(errorCode(blocked.body)).toBe('rate_limited');

    // Отмена одной активной записи освобождает место — тем же написанием номера.
    await db.appointment.update({ where: { id: secondId }, data: { status: 'cancelled' } });

    const allowed = await postBooking(
      bookingBody({
        masterId,
        serviceId,
        startsAt: (slots[9] as Slot).startsAt,
        idempotencyKey: nextKey(),
        clientPhone: '80001234567',
      }),
      ip,
    );
    expect(allowed.statusCode).toBe(201);
  });
});

describe('C6: параллельные запросы одного телефона не превышают лимит', () => {
  it('пять одновременных запросов — ровно три записи и два 429', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slots = await slotsOf({ serviceId, date });
    const phone = nextPhone();

    // Адреса разные: предмет теста — лимит телефона, а не IP-лимит.
    const responses = await Promise.all(
      [0, 1, 2, 3, 4].map((index) =>
        postBooking(
          bookingBody({
            masterId,
            serviceId,
            startsAt: (slots[index * 2] as Slot).startsAt,
            idempotencyKey: nextKey(),
            clientPhone: phone,
          }),
          `10.106.1.${index + 1}`,
        ),
      ),
    );

    const statuses = responses.map((response) => response.statusCode).sort((a, b) => a - b);
    expect(statuses).toEqual([201, 201, 201, 429, 429]);

    for (const response of responses.filter((item) => item.statusCode === 429)) {
      expect(errorCode(response.body)).toBe('rate_limited');
    }
    // Счёт идёт в транзакции под advisory-локом: четвёртой строки нет.
    expect(await db.appointment.count({ where: { clientPhone: phone } })).toBe(3);
  });
});

/**
 * Гонка двух одинаковых ретраев (ревью M1): оба запроса с тем же `idempotencyKey` прошли
 * предварительную проверку ключа, пока записи ещё не было. Второй ждёт advisory-лок по телефону,
 * после лока находит запись первого и обязан ответить идемпотентным 200, а не 429
 * `rate_limited` (у телефона уже две активные записи — его запись была бы третьей).
 */
describe('C7: два одинаковых ретрая — 200, а не 429', () => {
  it('ровно одна запись создана, оба ответа про тот же id, ни одного 429', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slots = await slotsOf({ serviceId, date });
    const phone = nextPhone();
    const idempotencyKey = nextKey();

    // Две активные будущие записи: третья ровно на пороге лимита (MAX_ACTIVE_BOOKINGS_PER_PHONE).
    await seedAppointment({ masterId, serviceId, slot: slots[0] as Slot, clientPhone: phone });
    await seedAppointment({ masterId, serviceId, slot: slots[1] as Slot, clientPhone: phone });

    const body = bookingBody({
      masterId,
      serviceId,
      startsAt: (slots[3] as Slot).startsAt,
      idempotencyKey,
      clientPhone: phone,
    });

    // Адреса разные: предмет теста — лимит телефона и идемпотентность, а не IP-счётчик.
    const responses = await Promise.all([
      postBooking(body, '10.106.2.1'),
      postBooking(body, '10.106.2.2'),
    ]);

    const statuses = responses.map((response) => response.statusCode).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 201]);
    // Ни одного 429: лимит телефона не должен перебивать идемпотентный повтор.
    for (const response of responses) {
      expect(response.statusCode).not.toBe(429);
    }

    const ids = responses.map((response) => bookingResponseSchema.parse(response.body).booking.id);
    expect(new Set(ids).size).toBe(1);
    // По телефону ровно три строки: две посеянные и одна созданная парой запросов.
    expect(await db.appointment.count({ where: { clientPhone: phone } })).toBe(3);
  });
});
