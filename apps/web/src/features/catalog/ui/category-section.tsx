import type { ServiceGroup } from '../model/group-services';
import { ServiceCard } from './service-card';

type CategorySectionProps = {
  group: ServiceGroup;
};

/** Группа услуг одной категории: заголовок h2 и список карточек. */
export function CategorySection({ group }: CategorySectionProps) {
  const headingId = `category-${group.categoryId ?? 'uncategorized'}`;

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="text-2xl font-semibold tracking-tight">
        {group.title}
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {group.items.map((service) => (
          <li key={service.id}>
            <ServiceCard service={service} />
          </li>
        ))}
      </ul>
    </section>
  );
}
