import type { Metadata } from 'next';
import { MagicLinkConsumer } from '@/features/auth';
import { Container } from '@/shared/ui/container';

export const metadata: Metadata = { title: 'Вход по ссылке' };

export default async function MagicLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = typeof params.token === 'string' ? params.token : null;

  return (
    <main className="py-12">
      <Container className="max-w-lg">
        <section className="flex flex-col gap-4 rounded-card border border-border bg-surface-raised p-6">
          <h1 className="text-2xl font-semibold">Вход по ссылке</h1>
          <MagicLinkConsumer token={token} />
        </section>
      </Container>
    </main>
  );
}
