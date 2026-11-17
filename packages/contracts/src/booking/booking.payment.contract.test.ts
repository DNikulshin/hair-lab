import { describe, expect, it } from 'vitest';
import { bookingPaymentSchema, bookingResponseSchema } from './booking.contract';

/**
 * Ссылка на оплату записи: только `https` (issue #108).
 * Значение рендерится в `href` на web, поэтому `javascript:` и `data:` недопустимы.
 * Значения в тестах вымышленные.
 */

const payment = {
  confirmationUrl: 'https://yoomoney.example.invalid/checkout?order=00000000',
  expiresAt: '2030-03-04T06:15:00.000Z',
};

/** Запись без оплаты: минимальный валидный ответ `POST /bookings`. */
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

describe('bookingPaymentSchema.confirmationUrl', () => {
  it('принимает ссылку на оплату только по https', () => {
    expect(bookingPaymentSchema.parse(payment).confirmationUrl).toBe(payment.confirmationUrl);
    expect(
      bookingPaymentSchema.safeParse({
        ...payment,
        confirmationUrl: 'https://yookassa.example.invalid/checkout/2a1b0d2f',
      }).success,
    ).toBe(true);
  });

  it('отклоняет javascript: и data: — значение попадает в href', () => {
    for (const confirmationUrl of [
      'javascript:alert(1)',
      'javascript://example.invalid/%0aalert(1)',
      'data:text/html,<h1>%D0%BE%D0%BF%D0%BB%D0%B0%D1%82%D0%B0</h1>',
    ]) {
      const result = bookingPaymentSchema.safeParse({ ...payment, confirmationUrl });

      expect(result.success).toBe(false);
      expect(result.success ? undefined : result.error.issues[0]?.path).toEqual([
        'confirmationUrl',
      ]);
    }
  });

  it('отклоняет http: и другие схемы', () => {
    for (const confirmationUrl of [
      'http://yookassa.example.invalid/checkout',
      'ftp://yookassa.example.invalid/checkout',
    ]) {
      expect(bookingPaymentSchema.safeParse({ ...payment, confirmationUrl }).success).toBe(false);
    }
  });

  it('по-прежнему отклоняет относительную ссылку', () => {
    for (const confirmationUrl of ['/checkout', 'checkout', '//yookassa.example.invalid/x']) {
      expect(bookingPaymentSchema.safeParse({ ...payment, confirmationUrl }).success).toBe(false);
    }
  });

  it('не влияет на форму ответа: booking с https-оплатой валиден, без оплаты — тоже', () => {
    const parsed = bookingResponseSchema.parse({ booking: { ...booking, payment } });

    expect(parsed.booking.payment?.confirmationUrl).toBe(payment.confirmationUrl);
    expect(Object.keys(parsed.booking.payment ?? {}).sort()).toEqual([
      'confirmationUrl',
      'expiresAt',
    ]);
    expect(bookingResponseSchema.parse({ booking }).booking.payment).toBeUndefined();
    expect(
      bookingResponseSchema.safeParse({
        booking: { ...booking, payment: { ...payment, confirmationUrl: 'javascript:alert(1)' } },
      }).success,
    ).toBe(false);
  });
});
