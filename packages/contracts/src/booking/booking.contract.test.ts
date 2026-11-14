import { describe, expect, it } from 'vitest';
import { defaultPageSize, maxPageSize } from '../common/pagination';
import {
  accountBookingResponseSchema,
  accountBookingsQuerySchema,
  accountBookingsResponseSchema,
  accountBookingSchema,
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

/** Запись в кабинете: те же снимки, что и у `booking`, плюс имена мастера и услуги. */
const accountBooking = {
  id: bookingId,
  startsAt: '2030-03-04T06:00:00.000Z',
  endsAt: '2030-03-04T07:00:00.000Z',
  status: 'confirmed' as const,
  price: { amountMinor: 350_000, currency: 'RUB' as const },
  durationMin: 60,
  serviceName: 'Стрижка',
  masterName: 'Тестовый Мастер',
  clientName: 'Тестовая Клиентка',
  clientPhoneMasked: '+7 (***) ***-**-89',
  cancellable: true,
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

  it('приводит телефон к E.164, принимая свободную запись российского номера', () => {
    expect(createBookingSchema.parse(createBody).clientPhone).toBe('+70000000000');
    expect(
      createBookingSchema.parse({ ...createBody, clientPhone: '8 (912) 345-67-89' }).clientPhone,
    ).toBe('+79123456789');
    expect(
      createBookingSchema.parse({ ...createBody, clientPhone: '+7 912 345 67 89' }).clientPhone,
    ).toBe('+79123456789');
  });

  it('принимает международный номер и приводит его к E.164', () => {
    const parsed = createBookingSchema.parse({ ...createBody, clientPhone: '+1 202 555 0143' });
    expect(parsed.clientPhone).toBe('+12025550143');
  });

  it('на не-телефон указывает поле и не повторяет значение в тексте ошибки', () => {
    const result = createBookingSchema.safeParse({ ...createBody, clientPhone: '+1 202 555 01' });
    expect(result.success).toBe(false);

    const issue = result.success ? undefined : result.error.issues[0];
    expect(issue?.path).toEqual(['clientPhone']);
    expect(issue?.message ?? '').not.toContain('202');
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

  it('принимает аддитивную маску телефона и остаётся валидной без неё', () => {
    const masked = bookingSchema.parse({ ...booking, clientPhoneMasked: '+7 (***) ***-**-89' });
    expect(masked.clientPhoneMasked).toBe('+7 (***) ***-**-89');
    expect(bookingSchema.parse(booking).clientPhoneMasked).toBeUndefined();
    expect(() => bookingSchema.parse({ ...booking, clientPhoneMasked: '' })).toThrow();
  });

  it('отклоняет неизвестный статус и неположительную длительность', () => {
    expect(() => bookingSchema.parse({ ...booking, status: 'new' })).toThrow();
    expect(() => bookingSchema.parse({ ...booking, durationMin: 0 })).toThrow();
  });
});

describe('accountBookingSchema', () => {
  it('принимает запись кабинета со всеми полями и без маски телефона', () => {
    const parsed = accountBookingSchema.parse(accountBooking);
    expect(parsed.masterName).toBe('Тестовый Мастер');
    expect(parsed.serviceName).toBe('Стрижка');
    expect(parsed.cancellable).toBe(true);
    expect(parsed.clientPhoneMasked).toBe('+7 (***) ***-**-89');

    const { clientPhoneMasked: _mask, ...withoutMask } = accountBooking;
    expect(accountBookingSchema.parse(withoutMask).clientPhoneMasked).toBeUndefined();
  });

  it('не содержит контактов клиента целиком и требует булев cancellable', () => {
    const parsed = accountBookingSchema.parse(accountBooking);
    expect(Object.keys(parsed)).not.toContain('clientPhone');
    expect(Object.keys(parsed)).not.toContain('clientEmail');
    expect(() => accountBookingSchema.parse({ ...accountBooking, cancellable: 'yes' })).toThrow();

    const { cancellable: _cancellable, ...withoutCancellable } = accountBooking;
    expect(() => accountBookingSchema.parse(withoutCancellable)).toThrow();
  });

  it('отклоняет время без зоны, пустые имена и неизвестный статус', () => {
    expect(() =>
      accountBookingSchema.parse({ ...accountBooking, startsAt: '2030-03-04 06:00' }),
    ).toThrow();
    expect(() => accountBookingSchema.parse({ ...accountBooking, masterName: '' })).toThrow();
    expect(() => accountBookingSchema.parse({ ...accountBooking, serviceName: '' })).toThrow();
    expect(() => accountBookingSchema.parse({ ...accountBooking, status: 'new' })).toThrow();
  });
});

describe('accountBookingsQuerySchema', () => {
  it('по умолчанию отдаёт upcoming с лимитом пагинации', () => {
    const parsed = accountBookingsQuerySchema.parse({});
    expect(parsed.scope).toBe('upcoming');
    expect(parsed.limit).toBe(defaultPageSize);
    expect(parsed.cursor).toBeUndefined();
  });

  it('принимает scope, limit и cursor и приводит limit из строки', () => {
    const parsed = accountBookingsQuerySchema.parse({ scope: 'past', limit: '5', cursor: 'abc' });
    expect(parsed.scope).toBe('past');
    expect(parsed.limit).toBe(5);
    expect(parsed.cursor).toBe('abc');
  });

  it('отклоняет неизвестный scope и limit вне допустимого диапазона', () => {
    expect(() => accountBookingsQuerySchema.parse({ scope: 'all' })).toThrow();
    expect(() => accountBookingsQuerySchema.parse({ limit: 0 })).toThrow();
    expect(() => accountBookingsQuerySchema.parse({ limit: maxPageSize + 1 })).toThrow();
    expect(() => accountBookingsQuerySchema.parse({ cursor: '' })).toThrow();
  });
});

describe('accountBookingsResponseSchema / accountBookingResponseSchema', () => {
  it('отдаёт список в обёртке {items, nextCursor}', () => {
    const parsed = accountBookingsResponseSchema.parse({
      items: [accountBooking],
      nextCursor: '2030-03-04T06:00:00.000Z|33333333-3333-4333-8333-333333333333',
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.nextCursor).toContain('|');
    expect(
      accountBookingsResponseSchema.parse({ items: [], nextCursor: null }).nextCursor,
    ).toBeNull();
    expect(() => accountBookingsResponseSchema.parse({ items: [accountBooking] })).toThrow();
  });

  it('возвращает отменённую запись в обёртке {booking}', () => {
    const parsed = accountBookingResponseSchema.parse({
      booking: { ...accountBooking, status: 'cancelled', cancellable: false },
    });
    expect(parsed.booking.status).toBe('cancelled');
    expect(parsed.booking.cancellable).toBe(false);
    expect(() => accountBookingResponseSchema.parse(accountBooking)).toThrow();
  });
});
