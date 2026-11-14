import type { Metadata } from 'next';
import Link from 'next/link';
import { Container } from '@/shared/ui/container';

/**
 * Офлайн-страница. Рендерится статически и попадает в precache service worker:
 * её показывает SW, когда сети нет, а запрошенная страница не найдена в кэше.
 *
 * Без данных и без API — иначе страница не собралась бы статически. `robots: noindex`:
 * в поиске ей делать нечего.
 */
export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Нет подключения',
  robots: { index: false },
};

export default function OfflinePage() {
  return (
    <main className="py-16">
      <Container className="max-w-lg">
        <section className="flex flex-col gap-4 rounded-card border border-border bg-surface-raised p-6">
          <h1 className="text-2xl font-semibold">Нет подключения</h1>
          <p className="text-sm text-muted">
            Похоже, интернет пропал. Проверьте соединение — и попробуйте снова: страницы, которые вы
            уже открывали, останутся доступны.
          </p>
          <p className="text-sm">
            <Link href="/" className="underline">
              На главную
            </Link>
          </p>
        </section>
      </Container>
    </main>
  );
}
