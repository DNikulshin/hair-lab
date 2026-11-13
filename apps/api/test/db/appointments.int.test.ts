import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { appointmentData, captureError, createFixture, createTestDb, sqlStateOf } from './helpers';

/**
 * Ограничения таблицы `appointments`, которые держат корректность записи
 * на уровне БД: непересечение слотов мастера, идемпотентность, FK, CHECK.
 */
const db = createTestDb();
const fixture = createFixture(db);

afterEach(async () => {
  await fixture.cleanup();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('appointments: непересечение слотов мастера', () => {
  it('отклоняет пересекающийся слот того же мастера (SQLSTATE 23P01)', async () => {
    const masterId = await fixture.master();
    const serviceId = await fixture.service();

    await db.appointment.create({
      data: appointmentData(masterId, serviceId, '2030-03-04T09:00:00Z', '2030-03-04T10:00:00Z'),
    });

    const error = await captureError(
      db.appointment.create({
        data: appointmentData(masterId, serviceId, '2030-03-04T09:30:00Z', '2030-03-04T10:30:00Z'),
      }),
    );

    expect(sqlStateOf(error)).toBe('23P01');
    expect(await db.appointment.count({ where: { masterId } })).toBe(1);
  });

  it('разрешает касание границ: конец одной записи равен началу другой', async () => {
    const masterId = await fixture.master();
    const serviceId = await fixture.service();

    await db.appointment.create({
      data: appointmentData(masterId, serviceId, '2030-03-04T09:00:00Z', '2030-03-04T10:00:00Z'),
    });
    await db.appointment.create({
      data: appointmentData(masterId, serviceId, '2030-03-04T10:00:00Z', '2030-03-04T11:00:00Z'),
    });

    expect(await db.appointment.count({ where: { masterId } })).toBe(2);
  });

  it('не блокирует слот другого мастера', async () => {
    const serviceId = await fixture.service();
    const firstMasterId = await fixture.master('Мастер Один');
    const secondMasterId = await fixture.master('Мастер Два');

    await db.appointment.create({
      data: appointmentData(
        firstMasterId,
        serviceId,
        '2030-03-04T09:00:00Z',
        '2030-03-04T10:00:00Z',
      ),
    });
    await db.appointment.create({
      data: appointmentData(
        secondMasterId,
        serviceId,
        '2030-03-04T09:00:00Z',
        '2030-03-04T10:00:00Z',
      ),
    });

    expect(await db.appointment.count({ where: { serviceId } })).toBe(2);
  });

  it('освобождает слот после отмены записи', async () => {
    const masterId = await fixture.master();
    const serviceId = await fixture.service();

    const cancelled = await db.appointment.create({
      data: appointmentData(masterId, serviceId, '2030-03-04T09:00:00Z', '2030-03-04T10:00:00Z'),
    });

    const blocked = await captureError(
      db.appointment.create({
        data: appointmentData(masterId, serviceId, '2030-03-04T09:15:00Z', '2030-03-04T10:15:00Z'),
      }),
    );
    expect(sqlStateOf(blocked)).toBe('23P01');

    await db.appointment.update({
      where: { id: cancelled.id },
      data: { status: 'cancelled', cancelReason: 'клиент передумал' },
    });

    const rebooked = await db.appointment.create({
      data: appointmentData(masterId, serviceId, '2030-03-04T09:15:00Z', '2030-03-04T10:15:00Z'),
    });

    expect(rebooked.status).toBe('pending');
    expect(await db.appointment.count({ where: { masterId, status: { not: 'cancelled' } } })).toBe(
      1,
    );
  });
});

describe('appointments: идемпотентность', () => {
  it('отклоняет повторную запись с тем же idempotencyKey (SQLSTATE 23505)', async () => {
    const masterId = await fixture.master();
    const serviceId = await fixture.service();
    const idempotencyKey = 'test-idempotency-key-0001';

    await db.appointment.create({
      data: appointmentData(masterId, serviceId, '2030-03-04T09:00:00Z', '2030-03-04T10:00:00Z', {
        idempotencyKey,
      }),
    });

    const error = await captureError(
      db.appointment.create({
        data: appointmentData(masterId, serviceId, '2030-03-05T09:00:00Z', '2030-03-05T10:00:00Z', {
          idempotencyKey,
        }),
      }),
    );

    expect(sqlStateOf(error)).toBe('23505');
    expect(await db.appointment.count({ where: { idempotencyKey } })).toBe(1);
  });

  it('разрешает несколько записей без idempotencyKey (NULL не конфликтует)', async () => {
    const masterId = await fixture.master();
    const serviceId = await fixture.service();

    await db.appointment.create({
      data: appointmentData(masterId, serviceId, '2030-03-04T09:00:00Z', '2030-03-04T10:00:00Z'),
    });
    await db.appointment.create({
      data: appointmentData(masterId, serviceId, '2030-03-04T11:00:00Z', '2030-03-04T12:00:00Z'),
    });

    expect(await db.appointment.count({ where: { masterId, idempotencyKey: null } })).toBe(2);
  });
});

describe('appointments: внешние ключи', () => {
  it('отклоняет запись на несуществующего мастера (SQLSTATE 23503)', async () => {
    const serviceId = await fixture.service();
    const error = await captureError(
      db.appointment.create({
        data: appointmentData(
          '00000000-0000-4000-8000-000000000000',
          serviceId,
          '2030-03-04T09:00:00Z',
          '2030-03-04T10:00:00Z',
        ),
      }),
    );

    expect(sqlStateOf(error)).toBe('23503');
  });

  it('отклоняет запись на несуществующую услугу (SQLSTATE 23503)', async () => {
    const masterId = await fixture.master();
    const error = await captureError(
      db.appointment.create({
        data: appointmentData(
          masterId,
          '00000000-0000-4000-8000-000000000000',
          '2030-03-04T09:00:00Z',
          '2030-03-04T10:00:00Z',
        ),
      }),
    );

    expect(sqlStateOf(error)).toBe('23503');
  });

  it('запрещает удаление услуги и мастера, на которые есть запись (Restrict)', async () => {
    const masterId = await fixture.master();
    const serviceId = await fixture.service();
    await db.appointment.create({
      data: appointmentData(masterId, serviceId, '2030-03-04T09:00:00Z', '2030-03-04T10:00:00Z'),
    });

    const serviceError = await captureError(db.service.delete({ where: { id: serviceId } }));
    const masterError = await captureError(db.master.delete({ where: { id: masterId } }));

    expect(sqlStateOf(serviceError)).toBe('23503');
    expect(sqlStateOf(masterError)).toBe('23503');
    expect(await db.appointment.count({ where: { masterId } })).toBe(1);
  });
});

describe('appointments: CHECK-ограничения', () => {
  it('отклоняет запись с ends_at <= starts_at (SQLSTATE 23514)', async () => {
    const masterId = await fixture.master();
    const serviceId = await fixture.service();

    const zeroLength = await captureError(
      db.appointment.create({
        data: appointmentData(masterId, serviceId, '2030-03-04T09:00:00Z', '2030-03-04T09:00:00Z'),
      }),
    );
    const inverted = await captureError(
      db.appointment.create({
        data: appointmentData(masterId, serviceId, '2030-03-04T10:00:00Z', '2030-03-04T09:00:00Z'),
      }),
    );

    expect(sqlStateOf(zeroLength)).toBe('23514');
    expect(sqlStateOf(inverted)).toBe('23514');
  });

  it('отклоняет отрицательную цену и нулевую длительность снимка (SQLSTATE 23514)', async () => {
    const masterId = await fixture.master();
    const serviceId = await fixture.service();

    const negativePrice = await captureError(
      db.appointment.create({
        data: {
          ...appointmentData(masterId, serviceId, '2030-03-04T09:00:00Z', '2030-03-04T10:00:00Z'),
          priceKopecks: -1,
        },
      }),
    );
    const zeroDuration = await captureError(
      db.appointment.create({
        data: {
          ...appointmentData(masterId, serviceId, '2030-03-04T11:00:00Z', '2030-03-04T12:00:00Z'),
          durationMin: 0,
        },
      }),
    );

    expect(sqlStateOf(negativePrice)).toBe('23514');
    expect(sqlStateOf(zeroDuration)).toBe('23514');
  });
});
