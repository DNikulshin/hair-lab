import type { ServiceGroup } from '../model/group-services';
import { maxDuration } from './duration-bar';
import { ServiceCard } from './service-card';

type CategorySectionProps = {
  group: ServiceGroup;
};

/** Группа услуг одной категории: заголовок h2 и список карточек. */
export function CategorySection({ group }: CategorySectionProps) {
  const headingId = `category-${group.categoryId ?? 'uncategorized'}`;
  const longest = maxDuration(group.items);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="text-2xl font-light">
        {group.title}
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {group.items.map((service) => (
          <li key={service.id}>
            <ServiceCard service={service} maxMinutes={longest} />
          </li>
        ))}
      </ul>
    </section>
  );
}
