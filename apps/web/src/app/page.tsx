import Link from 'next/link';
import { getMasters, getServices } from '@/features/catalog/api/catalog-api';
import { formatPrice } from '@/features/catalog/model/format';
import { siteConfig } from '@/shared/config/site';
import { Container } from '@/shared/ui/container';

/**
 * Динамический рендер: на главной превью каталога, и fallback «временно недоступен»
 * нельзя кэшировать как статическую страницу. Кэш данных в `catalog-api` отключён
 * (`no-store`) до появления on-demand revalidation.
 */
export const dynamic = 'force-dynamic';

/** Сколько элементов показываем в превью на главной. */
const PREVIEW_LIMIT = 4;

/**
 * Главная: hero-тизер и короткие превью каталога со ссылками на полные страницы.
 * Данные те же, что у витрины (общий загрузчик `catalog-api`), логики здесь нет.
 */
export default async function HomePage() {
  const [services, masters] = await Promise.all([getServices(), getMasters()]);
  const servicePreview = services.ok ? services.data.slice(0, PREVIEW_LIMIT) : [];
  const masterPreview = masters.ok ? masters.data.slice(0, PREVIEW_LIMIT) : [];

  return (
    <Container className="flex flex-col gap-16 py-16">
      <main className="flex flex-col gap-12">
        <section className="flex flex-col gap-6">
          <p className="text-sm uppercase tracking-[0.18em] text-muted">{siteConfig.city}</p>
          <h1 className="max-w-3xl text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            {siteConfig.name}
          </h1>
          <p className="max-w-xl text-lg text-muted">{siteConfig.description}</p>
          <div className="flex flex-wrap gap-3 pt-2">
            <span className="rounded-card border border-border bg-surface-raised px-4 py-2 text-sm">
              Каркас собран
            </span>
            <span className="rounded-card border border-border bg-surface-raised px-4 py-2 text-sm">
              Tailwind v4 + токены
            </span>
            <span className="rounded-card border border-border bg-surface-raised px-4 py-2 text-sm">
              Бренд из окружения
            </span>
          </div>
        </section>

        <section aria-labelledby="home-services" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="home-services" className="text-2xl font-semibold tracking-tight">
              Услуги
            </h2>
            <Link href="/services" className="text-sm underline">
              Все услуги и цены
            </Link>
          </div>
          {!services.ok ? (
            <p className="text-sm text-muted">Услуги и цены временно недоступны.</p>
          ) : servicePreview.length === 0 ? (
            <p className="text-sm text-muted">Прайс обновляется — загляните чуть позже.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {servicePreview.map((service) => (
                <li
                  key={service.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2 text-sm"
                >
                  <span>{service.name}</span>
                  <span className="text-muted">{formatPrice(service.price.amountMinor)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="home-masters" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="home-masters" className="text-2xl font-semibold tracking-tight">
              Мастера
            </h2>
            <Link href="/masters" className="text-sm underline">
              Все мастера
            </Link>
          </div>
          {!masters.ok ? (
            <p className="text-sm text-muted">Список мастеров временно недоступен.</p>
          ) : masterPreview.length === 0 ? (
            <p className="text-sm text-muted">
              Состав мастеров обновляется — загляните чуть позже.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {masterPreview.map((master) => (
                <li
                  key={master.id}
                  className="rounded-card border border-border bg-surface-raised px-4 py-2 text-sm"
                >
                  {master.fullName}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </Container>
  );
}
