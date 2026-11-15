import Link from 'next/link';
import { getMasters, getServices } from '@/features/catalog/api/catalog-api';
import { formatPrice } from '@/features/catalog/model/format';
import { DurationBar, maxDuration } from '@/features/catalog/ui/duration-bar';
import { siteConfig } from '@/shared/config/site';
import { ButtonLink } from '@/shared/ui/button';
import { Container } from '@/shared/ui/container';
import { Section } from '@/shared/ui/section';

/**
 * Динамический рендер: на главной превью каталога, и fallback «временно недоступен»
 * нельзя кэшировать как статическую страницу. Кэш данных в `catalog-api` отключён
 * (`no-store`) до появления on-demand revalidation.
 */
export const dynamic = 'force-dynamic';

/** Сколько элементов показываем в превью на главной. */
const PREVIEW_LIMIT = 4;

/**
 * Главная: дисплейный заголовок салона, линейка-сигнатура, превью услуг и мастеров.
 * Данные те же, что у витрины (общий загрузчик `catalog-api`), логики здесь нет.
 */
export default async function HomePage() {
  const [services, masters] = await Promise.all([getServices(), getMasters()]);
  const servicePreview = services.ok ? services.data.slice(0, PREVIEW_LIMIT) : [];
  const masterPreview = masters.ok ? masters.data.slice(0, PREVIEW_LIMIT) : [];
  const longest = maxDuration(services.ok ? services.data : []);

  return (
    <main>
      <Container className="flex flex-col gap-16 py-12 sm:py-16">
        <section className="flex flex-col gap-8">
          <div className="grid items-end gap-6 md:grid-cols-[1.55fr_1fr] md:gap-12">
            <h1 className="text-[clamp(2.5rem,7vw,4.5rem)] font-extralight leading-[0.95]">
              {siteConfig.name}
            </h1>
            <div className="flex max-w-sm flex-col gap-4 text-sm text-muted md:pb-2">
              <p>{siteConfig.description}</p>
              <p>
                Запись онлайн: свободное окно держим{' '}
                <span className="font-medium text-ink">15 минут</span>, звонить не нужно.
              </p>
            </div>
          </div>
          {/* Сигнатура системы: единственная акцентная линия на экране. */}
          <div aria-hidden="true" className="h-[5px] w-full bg-accent [transform:skewY(-1.1deg)]" />
        </section>

        <Section
          id="home-services"
          title="Услуги и длительность"
          description={`Прайс ${siteConfig.name}: цена и время указаны для каждой услуги.`}
          action={
            <Link href="/services" className="text-sm text-muted underline hover:text-ink">
              Все услуги и цены
            </Link>
          }
        >
          {!services.ok ? (
            <p className="text-sm text-muted">Услуги и цены временно недоступны.</p>
          ) : servicePreview.length === 0 ? (
            <p className="text-sm text-muted">Прайс обновляется — загляните чуть позже.</p>
          ) : (
            <ul className="flex flex-col">
              {servicePreview.map((service) => (
                <li
                  key={service.id}
                  className="flex flex-col gap-1.5 border-t border-border py-4 last:border-b sm:flex-row sm:items-center sm:gap-6"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-base font-medium">{service.name}</span>
                    {service.description ? (
                      <span className="text-sm text-muted">{service.description}</span>
                    ) : null}
                  </div>
                  {/* На узком экране шкала и цена уходят на свою строку: иначе название
                      сжимается до нескольких символов в строке. */}
                  <div className="flex items-center justify-between gap-4 sm:justify-end sm:gap-6">
                    <DurationBar minutes={service.durationMin} maxMinutes={longest} />
                    <span className="font-display text-lg font-light sm:w-24 sm:text-right">
                      {formatPrice(service.price.amountMinor)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          id="home-masters"
          title="Мастера"
          action={
            <Link href="/masters" className="text-sm text-muted underline hover:text-ink">
              Все мастера
            </Link>
          }
        >
          {!masters.ok ? (
            <p className="text-sm text-muted">Список мастеров временно недоступен.</p>
          ) : masterPreview.length === 0 ? (
            <p className="text-sm text-muted">
              Состав мастеров обновляется — загляните чуть позже.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-3">
              {masterPreview.map((master) => (
                <li
                  key={master.id}
                  className="flex items-center gap-3 rounded-card border border-border px-4 py-2.5"
                >
                  <span
                    aria-hidden="true"
                    className="flex size-9 items-center justify-center rounded-full border border-border font-display text-xs text-muted"
                  >
                    {master.fullName
                      .split(/\s+/)
                      .slice(0, 2)
                      .map((part) => part.charAt(0).toUpperCase())
                      .join('')}
                  </span>
                  <div className="flex flex-col">
                    <span className="text-sm">{master.fullName}</span>
                    {master.bio ? <span className="text-xs text-muted">{master.bio}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <section className="flex flex-wrap items-center justify-between gap-6 border-t border-ink pt-8">
          <div className="flex flex-col gap-1.5">
            <h2 className="text-xl font-light">Записаться на визит</h2>
            <p className="max-w-md text-sm text-muted">
              Выберите услугу, мастера и свободное время — подтверждение придёт на почту.
            </p>
          </div>
          <ButtonLink href="/services">Выбрать услугу</ButtonLink>
        </section>
      </Container>
    </main>
  );
}
