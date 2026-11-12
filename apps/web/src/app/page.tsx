import { Container } from '@/shared/ui/container';
import { siteConfig } from '@/shared/config/site';

/**
 * Временная главная: подтверждает, что тема, токены и конфиг из окружения работают.
 * Заменяется лендингом после утверждения визуального направления.
 */
export default function HomePage() {
  return (
    <Container className="flex min-h-dvh flex-col justify-center gap-6 py-16">
      <main className="flex flex-col gap-6">
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
      </main>
    </Container>
  );
}
