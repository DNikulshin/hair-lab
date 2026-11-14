import { describe, expect, it } from 'vitest';
import { bookingResponseSchema, bookingSchema } from '../booking/booking.contract';
import {
  bookingPaymentSchema,
  paymentStatusResponseSchema,
  paymentStatusSchema,
  yookassaWebhookSchema,
} from './payment.contract';

/**
 * Контракты оплаты записи: только статусы и ссылка на оплату, без персональных данных.
 * Значения в тестах вымышленные.
 */

const payment = {
  confirmationUrl: 'https://yoomoney.example.invalid/checkout?order=00000000',
  expiresAt: '2030-03-04T06:15:00.000Z',
};

describe('paymentStatusSchema', () => {
  it('принимает четыре статуса платежа', () => {
    for (const status of ['pending', 'succeeded', 'canceled', 'refunded']) {
      expect(paymentStatusSchema.parse(status)).toBe(status);
    }
  });

  it('не принимает статус записи вместо статуса платежа', () => {
    expect(paymentStatusSchema.safeParse('confirmed').success).toBe(false);
  });
});

describe('paymentStatusResponseSchema', () => {
  it('содержит только статус платежа и статус записи', () => {
    const parsed = paymentStatusResponseSchema.parse({
      status: 'pending',
      appointmentStatus: 'pending',
    });

    expect(Object.keys(parsed).sort()).toEqual(['appointmentStatus', 'status']);
  });

  it('не принимает ответ без статуса записи', () => {
    expect(paymentStatusResponseSchema.safeParse({ status: 'pending' }).success).toBe(false);
  });
});

describe('yookassaWebhookSchema', () => {
  it('разбирает уведомление и сохраняет неизвестные поля провайдера', () => {
    const parsed = yookassaWebhookSchema.parse({
      type: 'notification',
      event: 'payment.succeeded',
      object: {
        id: '2a1b0d2f-000f-5000-9000-1f0000000000',
        status: 'succeeded',
        paid: true,
        amount: { value: '3500.00', currency: 'RUB' },
      },
    });

    expect(parsed.event).toBe('payment.succeeded');
    expect(parsed.object.id).toBe('2a1b0d2f-000f-5000-9000-1f0000000000');
    expect(parsed.object).toMatchObject({ paid: true });
  });

  it('принимает уведомление без суммы: статус всё равно перезапрашивается', () => {
    const parsed = yookassaWebhookSchema.parse({
      type: 'notification',
      event: 'payment.canceled',
      object: { id: '2a1b0d2f-000f-5000-9000-1f0000000000', status: 'canceled' },
    });

    expect(parsed.object.amount).toBeUndefined();
  });

  it('отклоняет не-уведомление и уведомление без id платежа', () => {
    expect(
      yookassaWebhookSchema.safeParse({ type: 'payment', event: 'x', object: {} }).success,
    ).toBe(false);
    expect(
      yookassaWebhookSchema.safeParse({
        type: 'notification',
        event: 'payment.succeeded',
        object: { status: 'succeeded' },
      }).success,
    ).toBe(false);
  });
});

describe('bookingPaymentSchema в ответе записи', () => {
  const booking = {
    id: '33333333-3333-4333-8333-333333333333',
    masterId: '11111111-1111-4111-8111-111111111111',
    serviceId: '22222222-2222-4222-8222-222222222222',
    startsAt: '2030-03-04T06:00:00.000Z',
    endsAt: '2030-03-04T07:00:00.000Z',
    status: 'pending' as const,
    price: { amountMinor: 350_000, currency: 'RUB' as const },
    durationMin: 60,
    clientName: 'Тестовая Клиентка',
  };

  it('принимает ссылку на оплату и срок её действия', () => {
    expect(bookingPaymentSchema.parse(payment)).toEqual(payment);
    expect(
      bookingResponseSchema.parse({ booking: { ...booking, payment } }).booking.payment,
    ).toEqual(payment);
  });

  it('не требует `payment`: без оплаты ответ прежний (обратная совместимость)', () => {
    const parsed = bookingResponseSchema.parse({ booking });

    expect(parsed.booking.payment).toBeUndefined();
    expect(Object.keys(bookingSchema.parse(booking))).not.toContain('payment');
  });

  it('не принимает относительную ссылку на оплату и время без зоны', () => {
    expect(
      bookingPaymentSchema.safeParse({ ...payment, confirmationUrl: '/checkout' }).success,
    ).toBe(false);
    expect(
      bookingPaymentSchema.safeParse({ ...payment, expiresAt: '2030-03-04T06:15:00' }).success,
    ).toBe(false);
  });
});
