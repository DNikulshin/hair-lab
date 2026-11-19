import type { Metadata } from 'next';
import { RefundsScreen } from '@/features/admin';
import { siteConfig } from '@/shared/config/site';
import { Card } from '@/shared/ui/card';
import { Container } from '@/shared/ui/container';

/**
 * Админка салона: обзор возвратов.
 *
 * Страница тонкая: сессию сотрудника проверяет клиентский компонент (`GET /api/staff/me`),
 * потому что серверного механизма сессий в web нет, а паттерн клиентского фетча через
 * Route Handlers-прокси уже есть в админке записей. `force-dynamic` — данные персональные,
 * кэшировать нечего; service worker `/admin` в кэш не кладёт (см. `sw-policy`).
 *
 * `robots: noindex`: рабочее место сотрудника в поиске не нужно.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Возвраты',
  robots: { index: false },
};

export default function AdminRefundsPage() {
  return (
    <main>
      <Container className="max-w-3xl py-12 sm:py-16">
        <Card className="gap-6 p-6">
          <div className="flex flex-col gap-2 border-b border-border pb-5">
            <h1 className="text-[clamp(1.75rem,4vw,2.25rem)] font-extralight leading-tight">
              Возвраты
            </h1>
            <p className="text-sm text-muted">
              Платежи, по которым нужен возврат, и уже возвращённые деньги. Суммы и статусы считает
              сервер по дате платежа.
            </p>
          </div>
          <RefundsScreen timeZone={siteConfig.timeZone} />
        </Card>
      </Container>
    </main>
  );
}
