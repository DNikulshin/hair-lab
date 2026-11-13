import { apiErrorSchema, mastersResponseSchema, servicesResponseSchema } from '@hair-lab/contracts';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app/build-server';
import { createFixture, createTestDb } from './db/helpers';

/**
 * Публичный каталог через HTTP: `app.inject` + реальная БД.
 * Проверяет инварианты витрины (только активное), фильтр и порядок, формат ошибок.
 * Все данные вымышленные: реальных мастеров, цен и клиентов здесь нет.
 */
const db = createTestDb();
const fixture = createFixture(db);
const app = await buildServer();

afterEach(async () => {
  await fixture.cleanup();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

/** GET через inject: тело уже разобрано, схема ответа проверяется в самих тестах. */
async function get(url: string) {
  const response = await app.inject({ method: 'GET', url });
  return { statusCode: response.statusCode, body: response.json() as unknown };
}

describe('GET /services', () => {
  it('отдаёт активные услуги и скрывает неактивные и услуги неактивных категорий', async () => {
    const visibleCategoryId = await fixture.category({ name: 'Стрижки', sortOrder: 1 });
    const hiddenCategoryId = await fixture.category({
      name: 'Скрытая категория',
      isActive: false,
      sortOrder: 2,
    });

    const visibleServiceId = await fixture.service({
      name: 'Стрижка модельная',
      categoryId: visibleCategoryId,
      sortOrder: 1,
    });
    const serviceWithoutCategoryId = await fixture.service({
      name: 'Укладка без категории',
      description: 'Вымышленное описание',
      sortOrder: 2,
    });
    const inactiveServiceId = await fixture.service({
      name: 'Отключённая услуга',
      categoryId: visibleCategoryId,
      isActive: false,
      sortOrder: 3,
    });
    const serviceOfHiddenCategoryId = await fixture.service({
      name: 'Услуга скрытой категории',
      categoryId: hiddenCategoryId,
      sortOrder: 4,
    });

    const { statusCode, body } = await get('/services');

    expect(statusCode).toBe(200);
    const parsed = servicesResponseSchema.parse(body);
    const ids = parsed.items.map((item) => item.id);

    expect(ids).toContain(visibleServiceId);
    expect(ids).toContain(serviceWithoutCategoryId);
    expect(ids).not.toContain(inactiveServiceId);
    expect(ids).not.toContain(serviceOfHiddenCategoryId);

    const visible = parsed.items.find((item) => item.id === visibleServiceId);
    expect(visible?.price).toEqual({ amountMinor: 350_000, currency: 'RUB' });
    expect(visible?.durationMin).toBe(60);
    expect(visible?.category).toEqual({ id: visibleCategoryId, name: 'Стрижки' });

    const withoutCategory = parsed.items.find((item) => item.id === serviceWithoutCategoryId);
    expect(withoutCategory?.category).toBeNull();
    expect(withoutCategory?.description).toBe('Вымышленное описание');
  });

  it('фильтрует по categoryId, а чужой uuid даёт пустой список', async () => {
    const categoryId = await fixture.category({ name: 'Маникюр' });
    const otherCategoryId = await fixture.category({ name: 'Брови' });

    const inCategoryId = await fixture.service({ name: 'Маникюр классический', categoryId });
    const otherCategoryServiceId = await fixture.service({
      name: 'Коррекция бровей',
      categoryId: otherCategoryId,
    });

    const filtered = servicesResponseSchema.parse(
      (await get(`/services?categoryId=${categoryId}`)).body,
    );
    const filteredIds = filtered.items.map((item) => item.id);
    expect(filteredIds).toEqual([inCategoryId]);
    expect(filteredIds).not.toContain(otherCategoryServiceId);

    const unknownCategory = servicesResponseSchema.parse(
      (await get('/services?categoryId=00000000-0000-4000-8000-000000000000')).body,
    );
    expect(unknownCategory.items).toEqual([]);
  });

  it('сортирует по sortOrder, затем по имени', async () => {
    const lateId = await fixture.service({ name: 'Бета поздняя', sortOrder: 20 });
    const secondId = await fixture.service({ name: 'Гамма', sortOrder: 10 });
    const firstId = await fixture.service({ name: 'Альфа', sortOrder: 10 });

    const parsed = servicesResponseSchema.parse((await get('/services')).body);
    const ids = parsed.items.map((item) => item.id);

    expect(ids.indexOf(firstId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(firstId)).toBeLessThan(ids.indexOf(secondId));
    expect(ids.indexOf(secondId)).toBeLessThan(ids.indexOf(lateId));
  });
});

describe('GET /masters', () => {
  it('отдаёт активных мастеров и только их активные услуги', async () => {
    const categoryId = await fixture.category({ name: 'Стрижки' });
    const hiddenCategoryId = await fixture.category({ name: 'Скрытая', isActive: false });

    const visibleServiceId = await fixture.service({ name: 'Стрижка женская', categoryId });
    const inactiveServiceId = await fixture.service({
      name: 'Отключённая услуга',
      categoryId,
      isActive: false,
    });
    const serviceOfHiddenCategoryId = await fixture.service({
      name: 'Услуга скрытой категории',
      categoryId: hiddenCategoryId,
    });

    const secondMasterId = await fixture.master('Мастер Борис');
    const firstMasterId = await fixture.master('Мастер Анна');
    const masterWithoutServicesId = await fixture.master('Мастер Без Услуг');
    const inactiveMasterId = await fixture.master('Мастер Неактивный');

    for (const serviceId of [visibleServiceId, inactiveServiceId, serviceOfHiddenCategoryId]) {
      await fixture.link(firstMasterId, serviceId);
    }
    await fixture.link(secondMasterId, visibleServiceId);
    await db.master.update({ where: { id: inactiveMasterId }, data: { isActive: false } });

    const { statusCode, body } = await get('/masters');

    expect(statusCode).toBe(200);
    const parsed = mastersResponseSchema.parse(body);
    const ids = parsed.items.map((item) => item.id);

    expect(ids).toContain(firstMasterId);
    expect(ids).toContain(secondMasterId);
    expect(ids).toContain(masterWithoutServicesId);
    expect(ids).not.toContain(inactiveMasterId);
    expect(ids.indexOf(firstMasterId)).toBeLessThan(ids.indexOf(secondMasterId));

    const firstMaster = parsed.items.find((item) => item.id === firstMasterId);
    expect(firstMaster?.services.map((service) => service.id)).toEqual([visibleServiceId]);
    expect(firstMaster?.services[0]?.category).toEqual({ id: categoryId, name: 'Стрижки' });

    const masterWithoutServices = parsed.items.find((item) => item.id === masterWithoutServicesId);
    expect(masterWithoutServices?.services).toEqual([]);
    expect(masterWithoutServices?.bio).toBeUndefined();
    expect(masterWithoutServices?.photoUrl).toBeUndefined();
  });
});

describe('ошибки каталога', () => {
  it('отклоняет categoryId не-uuid как validation_error', async () => {
    const { statusCode, body } = await get('/services?categoryId=abc');

    expect(statusCode).toBe(400);
    const parsed = apiErrorSchema.parse(body);
    expect(parsed.error.code).toBe('validation_error');
  });

  it('не отдаёт карточку услуги: неизвестный путь — not_found', async () => {
    const { statusCode, body } = await get('/services/00000000-0000-4000-8000-000000000000');

    expect(statusCode).toBe(404);
    const parsed = apiErrorSchema.parse(body);
    expect(parsed.error.code).toBe('not_found');
  });
});
