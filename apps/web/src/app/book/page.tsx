import type { Metadata } from 'next';
import { getMasters, getServices } from '@/features/catalog/api/catalog-api';
import { EmptyState } from '@/features/catalog/ui/empty-state';
import { BookingWizard } from '@/features/booking/ui/booking-wizard';
import { siteConfig } from '@/shared/config/site';
import { Container } from '@/shared/ui/container';

/**
 * Гостевая онлайн-запись: аккаунт не нужен.
 *
 * Динамический рендер: если API недоступен, страница показывает понятное сообщение
 * (и телефон салона, если он задан), а не 500. Такой fallback нельзя кэшировать
 * статически — кэш данных каталога отключён (`no-store`).
 *
 * `robots: noindex`: страница записи — не посадочная, в поиске ей не место.
 * Параметры (`serviceId`) берём из query, чтобы кнопка на витрине вела сразу к шагу мастера.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Онлайн-запись',
  description: `Онлайн-запись в салон ${siteConfig.name} в ${siteConfig.city}: выберите услугу, мастера и удобное время.`,
  robots: { index: false, follow: false },
};

type BookPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Первое значение query-параметра: массивы (`?serviceId=a&serviceId=b`) не поддерживаем. */
function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export default async function BookPage({ searchParams }: BookPageProps) {
  const [services, masters, params] = await Promise.all([
    getServices(),
    getMasters(),
    searchParams,
  ]);

  return (
    <Container className="flex flex-col gap-8 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Онлайн-запись</h1>
        <p className="max-w-2xl text-muted">
          Записаться можно без регистрации: выберите услугу, мастера и время, оставьте контакты — мы
          позвоним и подтвердим визит.
        </p>
      </header>

      {!services.ok || !masters.ok ? (
        <div className="flex flex-col gap-4">
          <EmptyState variant="unavailable" />
          <p className="text-sm text-muted">
            Онлайн-запись сейчас недоступна. Позвоните в салон — подберём время вместе.
          </p>
        </div>
      ) : services.data.length === 0 ? (
        <EmptyState variant="empty" />
      ) : (
        <BookingWizard
          services={services.data}
          masters={masters.data}
          timeZone={siteConfig.timeZone}
          initialServiceId={firstParam(params.serviceId)}
        />
      )}
    </Container>
  );
}
