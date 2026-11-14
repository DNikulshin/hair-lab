import {
  apiErrorSchema,
  bookingResponseSchema,
  paymentStatusResponseSchema,
  slotsResponseSchema,
  type Slot,
} from '@hair-lab/contracts';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app/build-server';
import {
  createHoldsSweeper,
  PAYMENT_HOLD_MINUTES,
  type CreatePaymentInput,
  type CreateRefundInput,
  type GatewayPaymentStatus,
  type PaymentGateway,
} from '../src/features/payments';
import { env } from '../src/shared/config/env';
import { countOutboxFor, createFixture, createTestDb, fakeClient } from './db/helpers';

/**
 * Оплата записи через ЮKassa на реальной БД: холд, уведомления, авто­возврат и статус оплаты.
 *
 * Шлюз подменён поддельным объектом через опции `buildServer` — `process.env` в тестах
 * не мутируется, режим оплаты передаётся зависимостью. Все данные вымышленные, платежи
 * никуда не уходят, адреса провайдера — только для проверки allowlist.
 */
const db = createTestDb();
const fixture = createFixture(db);

/** Адрес из allowlist ЮKassa: диапазон 185.71.76.0/27. */
const ALLOWED_IP = '185.71.76.5';
/** Документационный адрес TEST-NET-3: вне allowlist. */
const BLOCKED_IP = '203.0.113.10';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

interface FakeGatewayControls {
  /** Статус, который вернёт перезапрос состояния платежа. */
  status: GatewayPaymentStatus;
  /** Сумма в ответе перезапроса; `null` — сумма из создания платежа. */
  amountKopecks: number | null;
  /** `createPayment` падает: ветка компенсации и ответ 502. */
  failCreatePayment: boolean;
  /** `createRefund` падает: API возвратов недоступен, обязанность фиксируется флагом. */
  failCreateRefund: boolean;
}

interface FakeGateway {
  gateway: PaymentGateway;
  controls: FakeGatewayControls;
  calls: {
    createPayment: CreatePaymentInput[];
    getPayment: string[];
    createRefund: CreateRefundInput[];
  };
}

/**
 * Поддельный шлюз: помнит суммы созданных платежей и отдаёт управляемый статус
 * при перезапросе. Никаких сетевых вызовов.
 */
function createFakeGateway(): FakeGateway {
  let counter = 0;
  const amounts = new Map<string, number>();
  const controls: FakeGatewayControls = {
    status: 'succeeded',
    amountKopecks: null,
    failCreatePayment: false,
    failCreateRefund: false,
  };
  const calls: FakeGateway['calls'] = { createPayment: [], getPayment: [], createRefund: [] };

  const gateway: PaymentGateway = {
    async createPayment(input) {
      calls.createPayment.push(input);
      if (controls.failCreatePayment) throw new Error('шлюз недоступен');

      counter += 1;
      const yookassaPaymentId = `2a1b0d2f-000f-5000-9000-${String(counter).padStart(12, '0')}`;
      amounts.set(yookassaPaymentId, input.amountKopecks);
      return {
        yookassaPaymentId,
        confirmationUrl: `https://yookassa.example.invalid/checkout/${counter}`,
      };
    },
    async getPayment(id) {
      calls.getPayment.push(id);
      const status = controls.status;
      return {
        id,
        status,
        paid: status === 'succeeded',
        amountKopecks: controls.amountKopecks ?? amounts.get(id) ?? 0,
      };
    },
    async createRefund(input) {
      calls.createRefund.push(input);
      if (controls.failCreateRefund) throw new Error('API возвратов недоступен');
      return {
        refundId: `refund-${String(calls.createRefund.length).padStart(4, '0')}`,
        status: 'ok',
      };
    },
  };

  return { gateway, controls, calls };
}

const fake = createFakeGateway();
/** Сервер в режиме по умолчанию (`PAYMENTS_MODE=off` из окружения). */
const plainApp = await buildServer();
/** Сервер в режиме оплаты с поддельным шлюзом. */
const paidApp = await buildServer({ payments: { enabled: true, gateway: fake.gateway } });

beforeEach(() => {
  fake.controls.status = 'succeeded';
  fake.controls.amountKopecks = null;
  fake.controls.failCreatePayment = false;
  fake.controls.failCreateRefund = false;
  fake.calls.createPayment.length = 0;
  fake.calls.getPayment.length = 0;
  fake.calls.createRefund.length = 0;
});

afterEach(async () => {
  await fixture.cleanup();
});

afterAll(async () => {
  await plainApp.close();
  await paidApp.close();
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
  return `payments-test-key-${keyCounter}`;
}

/** Мастер с услугой и сменой 09:00–12:00 в TZ салона на дату через N дней. */
async function setupSalon(daysAhead = 3) {
  const date = salonDatePlus(daysAhead);
  const masterId = await fixture.master();
  const serviceId = await fixture.service();
  await fixture.link(masterId, serviceId);
  await fixture.workingHours(masterId, dayOfWeekOf(date), 9 * 60, 12 * 60);
  return { masterId, serviceId, date };
}

type Server = typeof plainApp;

async function getSlots(app: Server, query: { serviceId: string; date: string }): Promise<Slot[]> {
  const search = new URLSearchParams(query);
  const response = await app.inject({ method: 'GET', url: `/slots?${search.toString()}` });
  expect(response.statusCode).toBe(200);
  return slotsResponseSchema.parse(response.json()).items;
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

async function postBooking(app: Server, body: object) {
  const response = await app.inject({ method: 'POST', url: '/bookings', payload: body });
  return { statusCode: response.statusCode, body: response.json() as unknown, raw: response.body };
}

/** Свободный слот салона и данные для записи на него. */
async function firstSlot(
  app: Server,
  salon: { masterId: string; serviceId: string; date: string },
) {
  const slots = await getSlots(app, { serviceId: salon.serviceId, date: salon.date });
  return slots[0] as Slot;
}

async function bookFirstSlot(app: Server, daysAhead = 3) {
  const salon = await setupSalon(daysAhead);
  const slot = await firstSlot(app, salon);
  const response = await postBooking(
    app,
    bookingBody({
      masterId: salon.masterId,
      serviceId: salon.serviceId,
      startsAt: slot.startsAt,
      idempotencyKey: nextKey(),
    }),
  );
  return { salon, slot, response };
}

function errorCode(body: unknown): string {
  return apiErrorSchema.parse(body).error.code;
}

/** Уведомление ЮKassa об изменении статуса платежа. */
function webhookBody(yookassaPaymentId: string, event: 'payment.succeeded' | 'payment.canceled') {
  return {
    type: 'notification',
    event,
    object: {
      id: yookassaPaymentId,
      status: event === 'payment.succeeded' ? 'succeeded' : 'canceled',
      paid: event === 'payment.succeeded',
      amount: { value: '3500.00', currency: 'RUB' },
    },
  };
}

function postWebhook(app: Server, body: object, remoteAddress: string) {
  return app.inject({
    method: 'POST',
    url: '/payments/webhooks/yookassa',
    payload: body,
    remoteAddress,
  });
}

async function appointmentOf(masterId: string) {
  return db.appointment.findFirstOrThrow({
    where: { masterId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      cancelReason: true,
      paymentDeadlineAt: true,
      clientEmail: true,
    },
  });
}

async function paymentOf(appointmentId: string) {
  return db.payment.findUniqueOrThrow({
    where: { appointmentId },
    select: {
      id: true,
      status: true,
      amountKopecks: true,
      yookassaPaymentId: true,
      confirmationUrl: true,
      refundRequired: true,
    },
  });
}

/** Свипер с тем же шлюзом, что у сервера: тик вызывается тестом, а не таймером. */
function createTestSweeper() {
  return createHoldsSweeper({
    db,
    gateway: fake.gateway,
    intervalMs: 30_000,
    logger: silentLogger,
  });
}

describe('POST /bookings: режим оплаты выключен (по умолчанию)', () => {
  it('не добавляет payment и ставит письмо-подтверждение', async () => {
    const { salon, response } = await bookFirstSlot(plainApp);

    expect(response.statusCode).toBe(201);
    const { booking } = bookingResponseSchema.parse(response.body);
    expect(booking.status).toBe('pending');
    expect(booking.payment).toBeUndefined();

    const appointment = await appointmentOf(salon.masterId);
    expect(appointment.paymentDeadlineAt).toBeNull();
    // Поведение прежнее: письмо-подтверждение пишется сразу, платежа нет.
    expect(await countOutboxFor(db, appointment.id)).toBe(1);
    expect(await db.payment.count({ where: { appointmentId: appointment.id } })).toBe(0);

    // ПДн: ни телефона, ни почты в ответе нет.
    expect(response.raw).not.toContain(fakeClient.phone);
    expect(response.raw).not.toContain(fakeClient.email);
  });
});

describe('POST /bookings: режим оплаты включён', () => {
  it('создаёт холд: ссылка на оплату, запись pending, письма нет, платёж pending', async () => {
    const before = Date.now();
    const { salon, response } = await bookFirstSlot(paidApp);

    expect(response.statusCode).toBe(201);
    const { booking } = bookingResponseSchema.parse(response.body);
    expect(booking.status).toBe('pending');
    expect(booking.payment?.confirmationUrl).toContain(
      'https://yookassa.example.invalid/checkout/',
    );

    const appointment = await appointmentOf(salon.masterId);
    // Дедлайн холда — now + 15 минут, он же уходит клиенту как срок действия ссылки.
    const deadline = appointment.paymentDeadlineAt;
    expect(deadline).not.toBeNull();
    expect(booking.payment?.expiresAt).toBe(deadline?.toISOString());
    expect((deadline as Date).getTime()).toBeGreaterThanOrEqual(
      before + PAYMENT_HOLD_MINUTES * MINUTE_MS - MINUTE_MS,
    );
    expect((deadline as Date).getTime()).toBeLessThanOrEqual(
      Date.now() + PAYMENT_HOLD_MINUTES * MINUTE_MS,
    );

    // Письмо-подтверждение уйдёт после оплаты: до неё строки в outbox нет.
    expect(await countOutboxFor(db, appointment.id)).toBe(0);

    const payment = await paymentOf(appointment.id);
    expect(payment.status).toBe('pending');
    expect(payment.amountKopecks).toBe(booking.price.amountMinor);
    expect(payment.confirmationUrl).toBe(booking.payment?.confirmationUrl);

    // В шлюз уходят только служебные данные: описание без имени, телефона и почты.
    const input = fake.calls.createPayment[0] as CreatePaymentInput;
    expect(input).toEqual({
      appointmentId: appointment.id,
      amountKopecks: 350_000,
      description: 'Оплата записи: Стрижка',
      returnUrl: env.YOOKASSA_RETURN_URL,
      idempotenceKey: `payment-${appointment.id}`,
    });
    expect(JSON.stringify(fake.calls.createPayment)).not.toContain(fakeClient.phone);
    expect(JSON.stringify(fake.calls.createPayment)).not.toContain(fakeClient.email);
    expect(JSON.stringify(fake.calls.createPayment)).not.toContain(fakeClient.name);
  });

  it('повтор по idempotencyKey (200) не создаёт второй платёж и не зовёт шлюз', async () => {
    const salon = await setupSalon();
    const slot = await firstSlot(paidApp, salon);
    const body = bookingBody({
      masterId: salon.masterId,
      serviceId: salon.serviceId,
      startsAt: slot.startsAt,
      idempotencyKey: nextKey(),
    });

    const first = await postBooking(paidApp, body);
    const second = await postBooking(paidApp, body);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);

    const firstBooking = bookingResponseSchema.parse(first.body).booking;
    const secondBooking = bookingResponseSchema.parse(second.body).booking;
    expect(secondBooking.id).toBe(firstBooking.id);
    // Ссылка на оплату берётся из БД: клиент получает ту же страницу оплаты.
    expect(secondBooking.payment).toEqual(firstBooking.payment);

    expect(fake.calls.createPayment).toHaveLength(1);
    expect(await db.payment.count({ where: { appointmentId: firstBooking.id } })).toBe(1);
  });

  it('сбой шлюза: 502, запись отменена, платёж canceled, слот свободен', async () => {
    fake.controls.failCreatePayment = true;
    const salon = await setupSalon();
    const slot = await firstSlot(paidApp, salon);

    const response = await postBooking(
      paidApp,
      bookingBody({
        masterId: salon.masterId,
        serviceId: salon.serviceId,
        startsAt: slot.startsAt,
        idempotencyKey: nextKey(),
      }),
    );

    expect(response.statusCode).toBe(502);
    // Нового кода ошибки в контракт не добавляем: старые клиенты разбирают тело Zod-схемой.
    expect(errorCode(response.body)).toBe('internal_error');

    const appointment = await appointmentOf(salon.masterId);
    expect(appointment.status).toBe('cancelled');
    expect(appointment.cancelReason).toBe('payment_creation_failed');
    expect(appointment.paymentDeadlineAt).toBeNull();
    expect((await paymentOf(appointment.id)).status).toBe('canceled');

    // Отменённая запись не держит слот: время снова предлагается к записи.
    const slotsAfter = await getSlots(paidApp, { serviceId: salon.serviceId, date: salon.date });
    expect(slotsAfter.map((item) => item.startsAt)).toContain(slot.startsAt);
  });
});

describe('POST /payments/webhooks/yookassa', () => {
  it('payment.succeeded: запись confirmed, платёж succeeded, ровно одно письмо', async () => {
    const { salon, response } = await bookFirstSlot(paidApp);
    const appointment = await appointmentOf(salon.masterId);
    const payment = await paymentOf(appointment.id);
    const yookassaPaymentId = payment.yookassaPaymentId as string;

    const webhook = await postWebhook(
      paidApp,
      webhookBody(yookassaPaymentId, 'payment.succeeded'),
      ALLOWED_IP,
    );

    expect(webhook.statusCode).toBe(200);
    const paid = await appointmentOf(salon.masterId);
    expect(paid.status).toBe('confirmed');
    expect(paid.paymentDeadlineAt).toBeNull();
    expect((await paymentOf(appointment.id)).status).toBe('succeeded');
    expect(await countOutboxFor(db, appointment.id)).toBe(1);

    // Повтор того же уведомления — no-op: статусы те же, письмо по-прежнему одно.
    const repeated = await postWebhook(
      paidApp,
      webhookBody(yookassaPaymentId, 'payment.succeeded'),
      ALLOWED_IP,
    );

    expect(repeated.statusCode).toBe(200);
    expect((await appointmentOf(salon.masterId)).status).toBe('confirmed');
    expect((await paymentOf(appointment.id)).status).toBe('succeeded');
    expect(await countOutboxFor(db, appointment.id)).toBe(1);
    expect(response.statusCode).toBe(201);
  });

  it('уведомление с адреса вне allowlist — 403 и без изменений', async () => {
    const { salon } = await bookFirstSlot(paidApp);
    const appointment = await appointmentOf(salon.masterId);
    const payment = await paymentOf(appointment.id);

    const webhook = await postWebhook(
      paidApp,
      webhookBody(payment.yookassaPaymentId as string, 'payment.succeeded'),
      BLOCKED_IP,
    );

    expect(webhook.statusCode).toBe(403);
    expect(errorCode(webhook.json())).toBe('forbidden');
    expect((await appointmentOf(salon.masterId)).status).toBe('pending');
    expect((await paymentOf(appointment.id)).status).toBe('pending');
    expect(await countOutboxFor(db, appointment.id)).toBe(0);
    // Состояние у провайдера даже не перезапрашивается.
    expect(fake.calls.getPayment).toHaveLength(0);
  });

  it('расхождение суммы — 200 и состояние не меняется', async () => {
    const { salon } = await bookFirstSlot(paidApp);
    const appointment = await appointmentOf(salon.masterId);
    const payment = await paymentOf(appointment.id);
    fake.controls.amountKopecks = payment.amountKopecks - 1;

    const webhook = await postWebhook(
      paidApp,
      webhookBody(payment.yookassaPaymentId as string, 'payment.succeeded'),
      ALLOWED_IP,
    );

    expect(webhook.statusCode).toBe(200);
    expect((await appointmentOf(salon.masterId)).status).toBe('pending');
    expect((await paymentOf(appointment.id)).status).toBe('pending');
    expect(await countOutboxFor(db, appointment.id)).toBe(0);
    expect(fake.calls.createRefund).toHaveLength(0);
  });

  it('оплата после истечения холда: возврат и платёж refunded', async () => {
    const { salon, slot } = await bookFirstSlot(paidApp);
    const appointment = await appointmentOf(salon.masterId);
    const payment = await paymentOf(appointment.id);
    const yookassaPaymentId = payment.yookassaPaymentId as string;

    // Холд истёк: свипер смотрит на `payment_deadline_at`, поэтому подменяем «сейчас».
    const sweeper = createTestSweeper();
    const tick = await sweeper.tick(new Date(Date.now() + (PAYMENT_HOLD_MINUTES + 5) * MINUTE_MS));

    expect(tick).toMatchObject({ expired: 1, paymentsCanceled: 1 });
    const expired = await appointmentOf(salon.masterId);
    expect(expired.status).toBe('cancelled');
    expect(expired.cancelReason).toBe('payment_expired');
    expect((await paymentOf(appointment.id)).status).toBe('canceled');

    // Слот освобождён: время снова предлагается к записи.
    const slotsAfter = await getSlots(paidApp, { serviceId: salon.serviceId, date: salon.date });
    expect(slotsAfter.map((item) => item.startsAt)).toContain(slot.startsAt);

    // Клиент всё-таки оплатил: подтвердить запись нельзя, деньги возвращаются.
    const webhook = await postWebhook(
      paidApp,
      webhookBody(yookassaPaymentId, 'payment.succeeded'),
      ALLOWED_IP,
    );

    expect(webhook.statusCode).toBe(200);
    expect(fake.calls.createRefund).toHaveLength(1);
    expect(fake.calls.createRefund[0]).toEqual({
      yookassaPaymentId,
      amountKopecks: payment.amountKopecks,
      idempotenceKey: `refund-${payment.id}`,
    });
    expect((await paymentOf(appointment.id)).status).toBe('refunded');
    expect((await appointmentOf(salon.masterId)).status).toBe('cancelled');
    // Отменённая запись письма не получает.
    expect(await countOutboxFor(db, appointment.id)).toBe(0);
  });

  it('payment.canceled: платёж canceled, запись cancelled(payment_canceled)', async () => {
    const { salon } = await bookFirstSlot(paidApp);
    const appointment = await appointmentOf(salon.masterId);
    const payment = await paymentOf(appointment.id);
    fake.controls.status = 'canceled';

    const webhook = await postWebhook(
      paidApp,
      webhookBody(payment.yookassaPaymentId as string, 'payment.canceled'),
      ALLOWED_IP,
    );

    expect(webhook.statusCode).toBe(200);
    expect((await paymentOf(appointment.id)).status).toBe('canceled');
    const canceled = await appointmentOf(salon.masterId);
    expect(canceled.status).toBe('cancelled');
    expect(canceled.cancelReason).toBe('payment_canceled');
    expect(await countOutboxFor(db, appointment.id)).toBe(0);
  });

  it('неизвестное событие и чужой платёж — 200 без изменений', async () => {
    const { salon } = await bookFirstSlot(paidApp);
    const appointment = await appointmentOf(salon.masterId);
    const payment = await paymentOf(appointment.id);

    // Неизвестное событие и незавершённый у провайдера платёж: состояние не меняется.
    // Решение принимается по перезапрошенному статусу, а не по названию события.
    fake.controls.status = 'pending';
    const unknownEvent = await postWebhook(
      paidApp,
      {
        type: 'notification',
        event: 'payment.waiting_for_capture',
        object: { id: payment.yookassaPaymentId as string, status: 'waiting_for_capture' },
      },
      ALLOWED_IP,
    );
    const unknownPayment = await postWebhook(
      paidApp,
      webhookBody('2a1b0d2f-000f-5000-9000-999999999999', 'payment.succeeded'),
      ALLOWED_IP,
    );

    expect(unknownEvent.statusCode).toBe(200);
    expect(unknownPayment.statusCode).toBe(200);
    expect((await appointmentOf(salon.masterId)).status).toBe('pending');
    expect((await paymentOf(appointment.id)).status).toBe('pending');
    expect(await countOutboxFor(db, appointment.id)).toBe(0);
    expect(fake.calls.createRefund).toHaveLength(0);
  });
});

describe('GET /bookings/:id/payment', () => {
  it('отдаёт статусы своей записи без персональных данных', async () => {
    const { salon } = await bookFirstSlot(paidApp);
    const appointment = await appointmentOf(salon.masterId);

    const pending = await paidApp.inject({
      method: 'GET',
      url: `/bookings/${appointment.id}/payment`,
    });

    expect(pending.statusCode).toBe(200);
    expect(paymentStatusResponseSchema.parse(pending.json())).toEqual({
      status: 'pending',
      appointmentStatus: 'pending',
    });
    // ПДн: ни телефона, ни почты, ни имени клиента в ответе нет.
    expect(pending.body).not.toContain(fakeClient.phone);
    expect(pending.body).not.toContain(fakeClient.email);
    expect(pending.body).not.toContain(fakeClient.name);

    await paidApp.inject({
      method: 'POST',
      url: '/payments/webhooks/yookassa',
      payload: webhookBody(
        (await paymentOf(appointment.id)).yookassaPaymentId as string,
        'payment.succeeded',
      ),
      remoteAddress: ALLOWED_IP,
    });

    const succeeded = await paidApp.inject({
      method: 'GET',
      url: `/bookings/${appointment.id}/payment`,
    });
    expect(succeeded.statusCode).toBe(200);
    expect(paymentStatusResponseSchema.parse(succeeded.json())).toEqual({
      status: 'succeeded',
      appointmentStatus: 'confirmed',
    });
  });

  it('404 для несуществующей записи и 400 для не-UUID', async () => {
    const missing = await paidApp.inject({
      method: 'GET',
      url: '/bookings/99999999-9999-4999-8999-999999999999/payment',
    });
    const broken = await paidApp.inject({
      method: 'GET',
      url: '/bookings/not-a-uuid/payment',
    });

    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing.json())).toBe('not_found');
    expect(broken.statusCode).toBe(400);
    expect(errorCode(broken.json())).toBe('validation_error');
  });
});
