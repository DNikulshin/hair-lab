import type { Metadata } from 'next';
import { getMasters } from '@/features/catalog/api/catalog-api';
import { EmptyState } from '@/features/catalog/ui/empty-state';
import { MasterCard } from '@/features/catalog/ui/master-card';
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
    title: 'Мастера и их услуги',
    description: `Мастера салона ${siteConfig.name}: услуги, которые оказывает каждый мастер.`,
    alternates: { canonical: '/masters' },
  };
}

export default async function MastersPage() {
  const masters = await getMasters();

  return (
    <Container className="flex flex-col gap-10 py-12 sm:py-16">
      <header className="flex flex-col gap-3 border-b border-ink pb-6">
        <h1 className="text-[clamp(2rem,5vw,3rem)] font-extralight leading-[1.05]">Мастера</h1>
        <p className="max-w-2xl text-sm text-muted">
          Кто работает в салоне {siteConfig.name} и какие услуги оказывает.
        </p>
      </header>

      {!masters.ok ? (
        <EmptyState variant="unavailable" />
      ) : masters.data.length === 0 ? (
        <EmptyState variant="empty" />
      ) : (
        <section aria-labelledby="masters-list" className="flex flex-col gap-4">
          <h2 id="masters-list" className="text-2xl font-light">
            Наши мастера
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2">
            {masters.data.map((master) => (
              <li key={master.id}>
                <MasterCard master={master} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </Container>
  );
}
