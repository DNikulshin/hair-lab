import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { captureError, createFixture, createTestDb, sqlStateOf } from './helpers';

/**
 * Ограничения каталога: услуги, рабочие часы мастеров, связи «мастер — услуга».
 */
const db = createTestDb();
const fixture = createFixture(db);

afterEach(async () => {
  await fixture.cleanup();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('services: CHECK-ограничения прайса', () => {
  it('отклоняет нулевую длительность услуги (SQLSTATE 23514)', async () => {
    const error = await captureError(
      db.service.create({ data: { name: 'Пустая услуга', durationMin: 0, priceKopecks: 100 } }),
    );

    expect(sqlStateOf(error)).toBe('23514');
  });

  it('отклоняет отрицательную цену услуги (SQLSTATE 23514)', async () => {
    const error = await captureError(
      db.service.create({ data: { name: 'Странная услуга', durationMin: 30, priceKopecks: -100 } }),
    );

    expect(sqlStateOf(error)).toBe('23514');
  });
});

describe('master_working_hours: CHECK и уникальность', () => {
  it('отклоняет день недели вне 0–6 (SQLSTATE 23514)', async () => {
    const masterId = await fixture.master();

    const tooBig = await captureError(
      db.masterWorkingHours.create({
        data: { masterId, dayOfWeek: 7, startMinute: 600, endMinute: 720 },
      }),
    );
    const negative = await captureError(
      db.masterWorkingHours.create({
        data: { masterId, dayOfWeek: -1, startMinute: 600, endMinute: 720 },
      }),
    );

    expect(sqlStateOf(tooBig)).toBe('23514');
    expect(sqlStateOf(negative)).toBe('23514');
  });

  it('отклоняет минуты вне суток и пустой интервал (SQLSTATE 23514)', async () => {
    const masterId = await fixture.master();

    const minuteOutOfRange = await captureError(
      db.masterWorkingHours.create({
        data: { masterId, dayOfWeek: 1, startMinute: 1441, endMinute: 1500 },
      }),
    );
    const emptyInterval = await captureError(
      db.masterWorkingHours.create({
        data: { masterId, dayOfWeek: 1, startMinute: 720, endMinute: 720 },
      }),
    );
    const invertedInterval = await captureError(
      db.masterWorkingHours.create({
        data: { masterId, dayOfWeek: 1, startMinute: 720, endMinute: 600 },
      }),
    );

    expect(sqlStateOf(minuteOutOfRange)).toBe('23514');
    expect(sqlStateOf(emptyInterval)).toBe('23514');
    expect(sqlStateOf(invertedInterval)).toBe('23514');
  });

  it('отклоняет дубль рабочих часов мастера (SQLSTATE 23505)', async () => {
    const masterId = await fixture.master();

    await db.masterWorkingHours.create({
      data: { masterId, dayOfWeek: 2, startMinute: 600, endMinute: 720 },
    });
    const error = await captureError(
      db.masterWorkingHours.create({
        data: { masterId, dayOfWeek: 2, startMinute: 600, endMinute: 900 },
      }),
    );

    expect(sqlStateOf(error)).toBe('23505');
    expect(await db.masterWorkingHours.count({ where: { masterId } })).toBe(1);
  });
});

describe('master_services: связь мастера и услуги', () => {
  it('отклоняет повторную связь мастера и услуги (SQLSTATE 23505)', async () => {
    const masterId = await fixture.master();
    const serviceId = await fixture.service();

    await db.masterService.create({ data: { masterId, serviceId } });
    const error = await captureError(db.masterService.create({ data: { masterId, serviceId } }));

    expect(sqlStateOf(error)).toBe('23505');
  });
});
