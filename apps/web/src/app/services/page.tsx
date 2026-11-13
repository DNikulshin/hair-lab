import type { Metadata } from 'next';
import { getServices } from '@/features/catalog/api/catalog-api';
import { groupServicesByCategory } from '@/features/catalog/model/group-services';
import { CategorySection } from '@/features/catalog/ui/category-section';
import { EmptyState } from '@/features/catalog/ui/empty-state';
import { siteConfig } from '@/shared/config/site';
import { Container } from '@/shared/ui/container';

/**
 * Динамический рендер: при недоступном API страница отдаёт fallback («временно недоступен»),
 * и этот fallback нельзя кэшировать как статическую страницу. Кэш данных в `catalog-api`
 * отключён (`no-store`) до появления on-demand revalidation.
 */
export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return {
    title: 'Услуги и цены',
    description: `Услуги и цены салона ${siteConfig.name} в ${siteConfig.city}: состав услуг, длительность и стоимость.`,
    alternates: { canonical: '/services' },
  };
}

export default async function ServicesPage() {
  const services = await getServices();

  return (
    <Container className="flex flex-col gap-8 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Услуги и цены</h1>
        <p className="max-w-2xl text-muted">
          Прайс салона {siteConfig.name} в {siteConfig.city}: цена и длительность указаны для каждой
          услуги.
        </p>
      </header>

      {!services.ok ? (
        <EmptyState variant="unavailable" />
      ) : services.data.length === 0 ? (
        <EmptyState variant="empty" />
      ) : (
        <div className="flex flex-col gap-10">
          {groupServicesByCategory(services.data).map((group) => (
            <CategorySection key={group.categoryId ?? 'uncategorized'} group={group} />
          ))}
        </div>
      )}
    </Container>
  );
}
