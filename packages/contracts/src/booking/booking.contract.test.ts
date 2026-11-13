import { describe, expect, it } from 'vitest';
import {
  bookingResponseSchema,
  bookingSchema,
  createBookingSchema,
  slotsQuerySchema,
  slotsResponseSchema,
} from './booking.contract';

/** Вымышленные данные записи: реальных клиентов, телефонов и почт здесь нет. */
const masterId = '11111111-1111-4111-8111-111111111111';
const serviceId = '22222222-2222-4222-8222-222222222222';
const bookingId = '33333333-3333-4333-8333-333333333333';

const createBody = {
  masterId,
  serviceId,
  startsAt: '2030-03-04T09:00:00+03:00',
  clientName: 'Тестовая Клиентка',
  clientPhone: '+70000000000',
  clientEmail: 'guest@example.invalid',
  idempotencyKey: 'test-idempotency-key-0001',
};

const booking = {
  id: bookingId,
  masterId,
  serviceId,
  startsAt: '2030-03-04T06:00:00.000Z',
  endsAt: '2030-03-04T07:00:00.000Z',
  status: 'pending' as const,
  price: { amountMinor: 350_000, currency: 'RUB' as const },
  durationMin: 60,
  clientName: 'Тестовая Клиентка',
};

describe('slotsQuerySchema', () => {
  it('принимает дату в TZ салона с мастером и без него', () => {
    expect(slotsQuerySchema.parse({ serviceId, date: '2030-03-04' }).masterId).toBeUndefined();
    expect(slotsQuerySchema.parse({ serviceId, masterId, date: '2030-03-04' }).masterId).toBe(
      masterId,
    );
  });

  it('отклоняет битый uuid и дату не в формате YYYY-MM-DD', () => {
    expect(() => slotsQuerySchema.parse({ serviceId: 'abc', date: '2030-03-04' })).toThrow();
    expect(() => slotsQuerySchema.parse({ serviceId, date: '04.03.2030' })).toThrow();
    expect(() => slotsQuerySchema.parse({ serviceId, date: '2030-03-04T09:00:00Z' })).toThrow();
    expect(() => slotsQuerySchema.parse({ serviceId })).toThrow();
  });
});

describe('slotsResponseSchema', () => {
  it('требует обёртку {items} и время с зоной', () => {
    const slot = {
      masterId,
      startsAt: '2030-03-04T06:00:00.000Z',
      endsAt: '2030-03-04T07:00:00.000Z',
    };

    expect(slotsResponseSchema.parse({ items: [slot] }).items).toHaveLength(1);
    expect(slotsResponseSchema.parse({ items: [] }).items).toEqual([]);
    expect(() => slotsResponseSchema.parse([slot])).toThrow();
    expect(() =>
      slotsResponseSchema.parse({ items: [{ ...slot, startsAt: '2030-03-04 06:00' }] }),
    ).toThrow();
  });
});

describe('createBookingSchema', () => {
  it('принимает корректное тело и применяет trim к контактам', () => {
    const parsed = createBookingSchema.parse({
      ...createBody,
      clientName: '  Тестовая Клиентка  ',
    });
    expect(parsed.clientName).toBe('Тестовая Клиентка');
    expect(parsed.clientEmail).toBe('guest@example.invalid');
  });

  it('принимает тело без необязательного email', () => {
    const { clientEmail: _clientEmail, ...withoutEmail } = createBody;
    expect(createBookingSchema.parse(withoutEmail).clientEmail).toBeUndefined();
  });

  it('отклоняет пустые контакты, короткий телефон и битую почту', () => {
    expect(() => createBookingSchema.parse({ ...createBody, clientName: '   ' })).toThrow();
    expect(() => createBookingSchema.parse({ ...createBody, clientPhone: '1234567' })).toThrow();
    expect(() =>
      createBookingSchema.parse({ ...createBody, clientEmail: 'not-an-email' }),
    ).toThrow();
  });

  it('отклоняет время без зоны, битый uuid и короткий idempotencyKey', () => {
    expect(() =>
      createBookingSchema.parse({ ...createBody, startsAt: '2030-03-04T09:00:00' }),
    ).toThrow();
    expect(() => createBookingSchema.parse({ ...createBody, masterId: 'abc' })).toThrow();
    expect(() => createBookingSchema.parse({ ...createBody, idempotencyKey: 'short' })).toThrow();
  });
});

describe('bookingResponseSchema', () => {
  it('возвращает запись в обёртке {booking}', () => {
    expect(bookingResponseSchema.parse({ booking }).booking.id).toBe(bookingId);
    expect(() => bookingResponseSchema.parse(booking)).toThrow();
  });

  it('не содержит контактов клиента, кроме имени', () => {
    const parsed = bookingSchema.parse(booking);
    expect(Object.keys(parsed)).not.toContain('clientPhone');
    expect(Object.keys(parsed)).not.toContain('clientEmail');
  });

  it('отклоняет неизвестный статус и неположительную длительность', () => {
    expect(() => bookingSchema.parse({ ...booking, status: 'new' })).toThrow();
    expect(() => bookingSchema.parse({ ...booking, durationMin: 0 })).toThrow();
  });
});
