import type { Service } from '@hair-lab/contracts';
import { describe, expect, it } from 'vitest';
import { UNCATEGORIZED_TITLE, groupServicesByCategory } from './group-services';

/** Тестовые услуги: только вымышленные названия и цены. */
function service(id: string, category: Service['category'], name = `Услуга ${id}`): Service {
  return {
    id,
    name,
    durationMin: 60,
    price: { amountMinor: 250000, currency: 'RUB' },
    category,
  };
}

describe('groupServicesByCategory', () => {
  it('возвращает пустой список для пустого каталога', () => {
    expect(groupServicesByCategory([])).toEqual([]);
  });

  it('группирует услуги по категориям, сохраняя порядок появления', () => {
    const haircuts = { id: 'cat-1', name: 'Стрижки' };
    const coloring = { id: 'cat-2', name: 'Окрашивание' };

    const groups = groupServicesByCategory([
      service('s1', haircuts),
      service('s2', coloring),
      service('s3', haircuts),
    ]);

    expect(groups.map((group) => group.title)).toEqual(['Стрижки', 'Окрашивание']);
    expect(groups[0]?.items.map((item) => item.id)).toEqual(['s1', 's3']);
    expect(groups[1]?.items.map((item) => item.id)).toEqual(['s2']);
  });

  it('складывает услуги без категории в группу «Прочее» в конце', () => {
    const haircuts = { id: 'cat-1', name: 'Стрижки' };

    const groups = groupServicesByCategory([
      service('s1', null),
      service('s2', haircuts),
      service('s3', null),
    ]);

    expect(groups.map((group) => group.title)).toEqual(['Стрижки', UNCATEGORIZED_TITLE]);
    expect(groups[0]?.categoryId).toBe('cat-1');
    expect(groups[1]?.categoryId).toBeNull();
    expect(groups[1]?.items.map((item) => item.id)).toEqual(['s1', 's3']);
  });

  it('не создаёт группу «Прочее», если услуг без категории нет', () => {
    const groups = groupServicesByCategory([service('s1', { id: 'cat-1', name: 'Стрижки' })]);

    expect(groups).toHaveLength(1);
    expect(groups.some((group) => group.categoryId === null)).toBe(false);
  });

  it('не создаёт пустых групп и склеивает услуги одной категории', () => {
    const haircuts = { id: 'cat-1', name: 'Стрижки' };

    const groups = groupServicesByCategory([
      service('s1', haircuts),
      service('s2', haircuts),
      service('s3', haircuts),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items).toHaveLength(3);
  });
});
