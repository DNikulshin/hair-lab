import type { Metadata } from 'next';
import { LoginForm } from '@/features/auth';
import { Container } from '@/shared/ui/container';

export const metadata: Metadata = { title: 'Войти' };

export default function LoginPage() {
  return (
    <main className="py-12">
      <Container className="max-w-lg">
        <section className="flex flex-col gap-6 rounded-card border border-border bg-surface-raised p-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold">Вход</h1>
            <p className="text-sm text-muted">Войдите в аккаунт по электронной почте и паролю.</p>
          </div>
          <LoginForm />
        </section>
      </Container>
    </main>
  );
}
