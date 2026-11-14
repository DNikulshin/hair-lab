import type { Metadata } from 'next';
import { AccountBookings } from '@/features/account';
import { siteConfig } from '@/shared/config/site';
import { Container } from '@/shared/ui/container';

/**
 * Кабинет клиента: мои записи и отмена.
 *
 * Страница тонкая: сессию проверяет клиентский компонент (`GET /auth/me`), потому что
 * серверная auth-выборка потянула бы новый механизм, а паттерн клиентского фетча в web
 * уже есть. `force-dynamic` — данные персональные, кэшировать нечего.
 *
 * `robots: noindex`: кабинет в поиске не нужен — гость всё равно уедет на вход.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Кабинет',
  description: `Мои записи в салон ${siteConfig.name}: предстоящие визиты и история.`,
  robots: { index: false },
};

export default function AccountPage() {
  return (
    <main className="py-12">
      <Container className="max-w-3xl">
        <section className="flex flex-col gap-6 rounded-card border border-border bg-surface-raised p-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold">Мои записи</h1>
            <p className="text-sm text-muted">
              Здесь видно предстоящие визиты и историю. Отменить запись можно не позже чем за два
              часа до начала — после этого позвоните в салон.
            </p>
          </div>
          <AccountBookings timeZone={siteConfig.timeZone} />
        </section>
      </Container>
    </main>
  );
}
