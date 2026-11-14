import { bookingResponseSchema, slotsResponseSchema, type Slot } from '@hair-lab/contracts';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app/build-server';
import {
  BOOKING_CANCELLATION_TYPE,
  BOOKING_CONFIRMATION_TYPE,
  cancelAccountBooking,
  createBookingCancellationTemplate,
  createBookingConfirmationTemplate,
} from '../src/features/bookings';
import { createBooking } from '../src/features/bookings/bookings.service';
import { env } from '../src/shared/config/env';
import {
  createDispatcher,
  createPrismaOutboxStore,
  type DispatcherLogger,
  type EmailMessage,
  type EmailTransport,
  type SendResult,
} from '../src/shared/email';
import { createFixture, createTestDb, fakeClient } from './db/helpers';

/**
 * Outbox писем на реальной БД: атомарность записи (запись + строка outbox одной транзакцией),
 * снимок данных и работа диспетчера с настоящим хранилищем и поддельным транспортом.
 * Все данные вымышленные, письма никуда не уходят.
 */
const db = createTestDb();
const fixture = createFixture(db);
const app = await buildServer();

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Строки outbox, созданные в обход записи (без appointment_id), убираем вручную. */
const orphanOutboxIds: string[] = [];

const silentLogger: DispatcherLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const template = createBookingConfirmationTemplate({
  timezone: env.SALON_TIMEZONE,
  fromName: 'Стриж Lab',
  fromEmail: 'no-reply@example.invalid',
});

const cancellationTemplate = createBookingCancellationTemplate({
  timezone: env.SALON_TIMEZONE,
  fromName: 'Стриж Lab',
  fromEmail: 'no-reply@example.invalid',
});

const templates = {
  [BOOKING_CONFIRMATION_TYPE]: template,
  [BOOKING_CANCELLATION_TYPE]: cancellationTemplate,
};

afterEach(async () => {
  await fixture.cleanup();
  if (orphanOutboxIds.length > 0) {
    await db.outboxMessage.deleteMany({ where: { id: { in: orphanOutboxIds } } });
    orphanOutboxIds.length = 0;
  }
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

function createFakeTransport(result: SendResult = { outcome: 'sent', responseCode: 250 }): {
  transport: EmailTransport;
  sent: EmailMessage[];
} {
  const sent: EmailMessage[] = [];
  return {
    sent,
    transport: {
      async send(message) {
        sent.push(message);
        return result;
      },
    },
  };
}

function runTick(transport: EmailTransport) {
  const dispatcher = createDispatcher({
    store: createPrismaOutboxStore(db),
    transport,
    templates,
    logger: silentLogger,
  });
  return dispatcher.tick();
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

function dayOfWeekOf(date: string): number {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

let keyCounter = 0;

function nextKey(): string {
  keyCounter += 1;
  return `outbox-test-key-${keyCounter}`;
}

/** Мастер «Тестовый Мастер» с услугой «Стрижка» (60 мин, 3500 ₽) и сменой 09:00–12:00. */
async function setupSalon() {
  const date = salonDatePlus(3);
  const masterId = await fixture.master();
  const serviceId = await fixture.service();
  await fixture.link(masterId, serviceId);
  await fixture.workingHours(masterId, dayOfWeekOf(date), 9 * 60, 12 * 60);
  return { masterId, serviceId, date };
}

async function firstSlot(serviceId: string, date: string): Promise<Slot> {
  const response = await app.inject({
    method: 'GET',
    url: `/slots?serviceId=${serviceId}&date=${date}`,
  });
  return slotsResponseSchema.parse(response.json()).items[0] as Slot;
}

function bookingBody(params: {
  masterId: string;
  serviceId: string;
  startsAt: string;
  idempotencyKey: string;
  clientEmail?: string;
}) {
  const { clientEmail = fakeClient.email, ...rest } = params;
  return {
    ...rest,
    clientName: fakeClient.name,
    clientPhone: fakeClient.phone,
    clientEmail,
  };
}

async function postBooking(body: Record<string, unknown>) {
  const response = await app.inject({ method: 'POST', url: '/bookings', payload: body });
  return { statusCode: response.statusCode, body: response.json() as unknown };
}

describe('outbox: запись в одной транзакции с записью на услугу', () => {
  it('201 с email — ровно одна pending-строка со снимком услуги и мастера', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = await firstSlot(serviceId, date);

    const { statusCode, body } = await postBooking(
      bookingBody({ masterId, serviceId, startsAt: slot.startsAt, idempotencyKey: nextKey() }),
    );
    expect(statusCode).toBe(201);
    const { booking } = bookingResponseSchema.parse(body);

    const rows = await db.outboxMessage.findMany({ where: { appointmentId: booking.id } });
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.type).toBe(BOOKING_CONFIRMATION_TYPE);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.sentAt).toBeNull();
    expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(row.payload).toEqual({
      clientName: fakeClient.name,
      clientEmail: fakeClient.email,
      serviceName: 'Стрижка',
      masterName: 'Тестовый Мастер',
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      priceKopecks: 350_000,
      durationMin: 60,
    });
  });

  it('без clientEmail письма нет, запись создаётся', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = await firstSlot(serviceId, date);
    const body = bookingBody({
      masterId,
      serviceId,
      startsAt: slot.startsAt,
      idempotencyKey: nextKey(),
    });
    const withoutEmail = { ...body } as Record<string, unknown>;
    delete withoutEmail.clientEmail;

    const { statusCode, body: responseBody } = await postBooking(withoutEmail);
    expect(statusCode).toBe(201);

    const { booking } = bookingResponseSchema.parse(responseBody);
    expect(await db.outboxMessage.count({ where: { appointmentId: booking.id } })).toBe(0);
  });

  it('повтор по idempotencyKey (200) не создаёт вторую строку', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = await firstSlot(serviceId, date);
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

    const { booking } = bookingResponseSchema.parse(second.body);
    expect(await db.outboxMessage.count({ where: { appointmentId: booking.id } })).toBe(1);
  });

  it('409 conflict (тот же ключ, другое время) не оставляет строк outbox', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slots = slotsResponseSchema.parse(
      (
        await app.inject({ method: 'GET', url: `/slots?serviceId=${serviceId}&date=${date}` })
      ).json(),
    ).items;
    const idempotencyKey = nextKey();

    // Запись уже существует с этим ключом (создана в обход HTTP).
    const existingId = await fixture.appointment(
      masterId,
      serviceId,
      (slots[0] as Slot).startsAt,
      (slots[0] as Slot).endsAt,
      { idempotencyKey },
    );

    const response = await postBooking(
      bookingBody({
        masterId,
        serviceId,
        startsAt: (slots[1] as Slot).startsAt,
        idempotencyKey,
      }),
    );

    expect(response.statusCode).toBe(409);
    expect(await db.outboxMessage.count({ where: { appointmentId: existingId } })).toBe(0);
  });

  it('гонка за один слот: одна запись и одна строка outbox', async () => {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = await firstSlot(serviceId, date);

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
    expect(created).toHaveLength(1);

    const appointments = await db.appointment.findMany({
      where: { masterId },
      select: { id: true },
    });
    expect(appointments).toHaveLength(1);
    expect(await db.outboxMessage.count()).toBe(1);
  });
});

describe('outbox: диспетчер на реальном хранилище', () => {
  /** Запись через API: возвращает id записи и id созданной строки outbox. */
  async function bookWithEmail(): Promise<{ appointmentId: string; outboxId: string }> {
    const { masterId, serviceId, date } = await setupSalon();
    const slot = await firstSlot(serviceId, date);
    const { statusCode, body } = await postBooking(
      bookingBody({ masterId, serviceId, startsAt: slot.startsAt, idempotencyKey: nextKey() }),
    );
    expect(statusCode).toBe(201);
    const { booking } = bookingResponseSchema.parse(body);
    const row = await db.outboxMessage.findFirstOrThrow({
      where: { appointmentId: booking.id },
      select: { id: true },
    });
    return { appointmentId: booking.id, outboxId: row.id };
  }

  it('успешная отправка переводит строку в sent и второй тик её не повторяет', async () => {
    const { outboxId } = await bookWithEmail();
    const { transport, sent } = createFakeTransport();

    const first = await runTick(transport);
    expect(first.sent).toBeGreaterThanOrEqual(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(fakeClient.email);
    expect(sent[0]?.subject).toBeTruthy();

    const row = await db.outboxMessage.findUniqueOrThrow({ where: { id: outboxId } });
    expect(row.status).toBe('sent');
    expect(row.sentAt).not.toBeNull();

    await runTick(transport);
    expect(sent).toHaveLength(1);
  });

  it('временная ошибка — attempts + 1 и пауза 1 минута', async () => {
    const { outboxId } = await bookWithEmail();
    const { transport } = createFakeTransport({ outcome: 'retry', responseCode: 421 });

    const before = Date.now();
    await runTick(transport);

    const row = await db.outboxMessage.findUniqueOrThrow({ where: { id: outboxId } });
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('smtp 421');
    expect(row.sentAt).toBeNull();
    expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + MINUTE_MS - 1_000);
  });

  it('постоянный отказ получателя — suppressed', async () => {
    const { outboxId } = await bookWithEmail();
    const { transport } = createFakeTransport({ outcome: 'suppressed', responseCode: 550 });

    await runTick(transport);

    const row = await db.outboxMessage.findUniqueOrThrow({ where: { id: outboxId } });
    expect(row.status).toBe('suppressed');
    expect(row.lastError).toBe('smtp 550');
  });

  it('просроченное событие — failed(expired), письмо не отправляется', async () => {
    const pastStartsAt = new Date(Date.now() - MINUTE_MS);
    const orphan = await db.outboxMessage.create({
      data: {
        type: BOOKING_CONFIRMATION_TYPE,
        payload: {
          clientName: fakeClient.name,
          clientEmail: fakeClient.email,
          serviceName: 'Стрижка',
          masterName: 'Тестовый Мастер',
          startsAt: pastStartsAt.toISOString(),
          endsAt: new Date(pastStartsAt.getTime() + 60 * MINUTE_MS).toISOString(),
          priceKopecks: 350_000,
          durationMin: 60,
        },
      },
      select: { id: true },
    });
    orphanOutboxIds.push(orphan.id);
    const { transport, sent } = createFakeTransport();

    await runTick(transport);

    const row = await db.outboxMessage.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(row.status).toBe('failed');
    expect(row.lastError).toBe('expired');
    expect(sent).toHaveLength(0);
  });

  it('неизвестный тип письма — failed(unknown_type)', async () => {
    const orphan = await db.outboxMessage.create({
      data: { type: 'unknown_type', payload: {} },
      select: { id: true },
    });
    orphanOutboxIds.push(orphan.id);
    const { transport } = createFakeTransport();

    await runTick(transport);

    const row = await db.outboxMessage.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(row.status).toBe('failed');
    expect(row.lastError).toBe('unknown_type');
  });

  it('отмена: suppressed-подтверждение не забирается, письмо об отмене уходит один раз', async () => {
    // Запись и подтверждение — через сервис записи (production-снимок), отмена — через сервис
    // кабинета: отмену без сессии клиента проверяем на том же коде, что и маршрут.
    const { masterId, serviceId, date } = await setupSalon();
    const slot = await firstSlot(serviceId, date);
    const clientId = await fixture.client();
    const created = await createBooking(
      db,
      {
        masterId,
        serviceId,
        startsAt: slot.startsAt,
        clientName: fakeClient.name,
        clientPhone: fakeClient.phone,
        clientEmail: fakeClient.email,
        idempotencyKey: nextKey(),
      },
      clientId,
    );
    expect(created.status).toBe(201);
    const appointmentId = created.booking.id;

    expect((await cancelAccountBooking(db, clientId, appointmentId)).status).toBe('cancelled');

    const beforeTick = await db.outboxMessage.findMany({
      where: { appointmentId },
      select: { id: true, type: true, status: true },
    });
    expect(beforeTick).toHaveLength(2);
    const confirmationId = beforeTick.find((row) => row.type === BOOKING_CONFIRMATION_TYPE)?.id;
    expect(beforeTick.find((row) => row.id === confirmationId)?.status).toBe('suppressed');

    const { transport, sent } = createFakeTransport();
    await runTick(transport);

    // Тик может забрать и чужие pending-строки dev-БД (issue #80), поэтому фильтруем по теме.
    const cancellations = sent.filter((message) => message.subject.includes('Запись отменена'));
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]?.to).toBe(fakeClient.email);
    // Тело письма без ПДн, которых нет в снимке: телефона клиента в нём нет.
    expect(cancellations[0]?.text).not.toContain(fakeClient.phone);
    expect(cancellations[0]?.html).not.toContain(fakeClient.phone);

    // Подавленное подтверждение осталось нетронутым: тик его не забирал и не переотправлял.
    const confirmation = await db.outboxMessage.findUniqueOrThrow({
      where: { id: confirmationId ?? '' },
    });
    expect(confirmation.status).toBe('suppressed');
    expect(confirmation.attempts).toBe(0);
    expect(confirmation.sentAt).toBeNull();

    // Второй тик не дублирует письмо об отмене.
    await runTick(transport);
    expect(sent.filter((message) => message.subject.includes('Запись отменена'))).toHaveLength(1);
    const again = await db.outboxMessage.findMany({
      where: { appointmentId, type: BOOKING_CANCELLATION_TYPE },
      select: { status: true, sentAt: true },
    });
    expect(again).toHaveLength(1);
    expect(again[0]?.status).toBe('sent');
    expect(again[0]?.sentAt).not.toBeNull();
  });
});
