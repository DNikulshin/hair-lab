import type { Metadata } from 'next';
import { AdminScreen } from '@/features/admin';
import { siteConfig } from '@/shared/config/site';
import { Card } from '@/shared/ui/card';
import { Container } from '@/shared/ui/container';

/**
 * Админка салона: вход сотрудника, записи на день и действия над ними.
 *
 * Страница тонкая: сессию сотрудника проверяет клиентский компонент (`GET /api/staff/me`),
 * потому что серверного механизма сессий в web нет, а паттерн клиентского фетча через
 * Route Handlers-прокси уже есть в кабинете клиента. `force-dynamic` — данные персональные,
 * кэшировать нечего; service worker `/admin` в кэш не кладёт (см. `sw-policy`).
 *
 * `robots: noindex`: рабочее место сотрудника в поиске не нужно.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Админка',
  robots: { index: false },
};

export default function AdminPage() {
  return (
    <main>
      <Container className="max-w-3xl py-12 sm:py-16">
        <Card className="gap-6 p-6">
          <div className="flex flex-col gap-2 border-b border-border pb-5">
            <h1 className="text-[clamp(1.75rem,4vw,2.25rem)] font-extralight leading-tight">
              Админка
            </h1>
            <p className="text-sm text-muted">
              Рабочее место сотрудника: записи на день, подтверждение, завершение и отмена визита.
            </p>
          </div>
          <AdminScreen timeZone={siteConfig.timeZone} />
        </Card>
      </Container>
    </main>
  );
}
