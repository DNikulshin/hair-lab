import type { Service } from '@hair-lab/contracts';

/**
 * Группировка плоского списка услуг по категориям для витрины.
 *
 * Порядок групп — порядок первого появления в исходном списке (API отдаёт услуги
 * по `sortOrder` категории и имени), поэтому дополнительная сортировка не нужна.
 * Услуги без категории собираются в группу «Прочее» в конце списка.
 * Пустые группы не создаются.
 */

/** Заголовок группы услуг без категории. */
export const UNCATEGORIZED_TITLE = 'Прочее';

export interface ServiceGroup {
  /** `null` — услуги без категории. */
  categoryId: string | null;
  title: string;
  items: Service[];
}

export function groupServicesByCategory(items: readonly Service[]): ServiceGroup[] {
  const namedGroups = new Map<string, ServiceGroup>();
  const orderedGroups: ServiceGroup[] = [];
  const uncategorized: ServiceGroup = {
    categoryId: null,
    title: UNCATEGORIZED_TITLE,
    items: [],
  };

  for (const item of items) {
    const category = item.category;
    if (category === null) {
      uncategorized.items.push(item);
      continue;
    }

    let group = namedGroups.get(category.id);
    if (group === undefined) {
      group = { categoryId: category.id, title: category.name, items: [] };
      namedGroups.set(category.id, group);
      orderedGroups.push(group);
    }
    group.items.push(item);
  }

  return uncategorized.items.length > 0 ? [...orderedGroups, uncategorized] : orderedGroups;
}
