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
    <main>
      <Container className="max-w-lg py-12 sm:py-16">
        <section className="flex flex-col gap-4 rounded-card border border-border bg-surface-raised p-6">
          <h1 className="text-[clamp(1.5rem,3.5vw,2rem)] font-extralight leading-tight">
            Вход по ссылке
          </h1>
          <MagicLinkConsumer token={token} />
        </section>
      </Container>
    </main>
  );
}
