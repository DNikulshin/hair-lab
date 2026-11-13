import { describe, expect, it } from 'vitest';
import {
  mastersResponseSchema,
  serviceSchema,
  servicesQuerySchema,
  servicesResponseSchema,
} from './catalog.contract';

/** Вымышленные данные каталога: реальных мастеров, цен и ссылок здесь нет. */
const category = { id: '11111111-1111-4111-8111-111111111111', name: 'Стрижки' };

const service = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Стрижка модельная',
  description: 'Только для теста схемы',
  durationMin: 60,
  price: { amountMinor: 350_000, currency: 'RUB' },
  category,
};

describe('serviceSchema', () => {
  it('принимает услугу с категорией и без неё', () => {
    expect(serviceSchema.parse(service).category?.name).toBe('Стрижки');
    expect(serviceSchema.parse({ ...service, category: null }).category).toBeNull();
    expect(serviceSchema.parse({ ...service, description: undefined }).description).toBeUndefined();
  });

  it('отклоняет дробную и отрицательную цену', () => {
    expect(() =>
      serviceSchema.parse({ ...service, price: { amountMinor: 350_000.5, currency: 'RUB' } }),
    ).toThrow();
    expect(() =>
      serviceSchema.parse({ ...service, price: { amountMinor: -1, currency: 'RUB' } }),
    ).toThrow();
  });

  it('отклоняет неположительную и дробную длительность', () => {
    expect(() => serviceSchema.parse({ ...service, durationMin: 0 })).toThrow();
    expect(() => serviceSchema.parse({ ...service, durationMin: 30.5 })).toThrow();
  });

  it('отклоняет отсутствующие поля и битый uuid', () => {
    const { name: _name, ...withoutName } = service;
    expect(() => serviceSchema.parse(withoutName)).toThrow();
    expect(() => serviceSchema.parse({ ...service, id: 'not-a-uuid' })).toThrow();
    expect(() =>
      serviceSchema.parse({ ...service, category: { id: 'abc', name: 'Стрижки' } }),
    ).toThrow();
  });
});

describe('servicesQuerySchema', () => {
  it('принимает пустой фильтр и корректный uuid', () => {
    expect(servicesQuerySchema.parse({}).categoryId).toBeUndefined();
    expect(servicesQuerySchema.parse({ categoryId: category.id }).categoryId).toBe(category.id);
  });

  it('отклоняет битый uuid', () => {
    expect(() => servicesQuerySchema.parse({ categoryId: 'abc' })).toThrow();
  });
});

describe('servicesResponseSchema и mastersResponseSchema', () => {
  it('требует обёртку {items}', () => {
    expect(servicesResponseSchema.parse({ items: [service] }).items).toHaveLength(1);
    expect(() => servicesResponseSchema.parse([service])).toThrow();
    expect(servicesResponseSchema.parse({ items: [] }).items).toEqual([]);
  });

  it('принимает мастера с услугами и с пустым списком услуг', () => {
    const master = {
      id: '33333333-3333-4333-8333-333333333333',
      fullName: 'Вымышленный Мастер',
      bio: 'Только для теста схемы',
      photoUrl: 'https://example.invalid/master.jpg',
      services: [service],
    };

    expect(mastersResponseSchema.parse({ items: [master] }).items[0]?.services).toHaveLength(1);
    expect(
      mastersResponseSchema.parse({ items: [{ ...master, services: [] }] }).items,
    ).toHaveLength(1);
    expect(() =>
      mastersResponseSchema.parse({ items: [{ ...master, services: undefined }] }),
    ).toThrow();
  });
});
