import type { Metadata } from 'next';
import { RegisterForm } from '@/features/auth';
import { Container } from '@/shared/ui/container';

export const metadata: Metadata = { title: 'Регистрация' };

export default function RegisterPage() {
  return (
    <main className="py-12">
      <Container className="max-w-lg">
        <section className="flex flex-col gap-6 rounded-card border border-border bg-surface-raised p-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold">Создать аккаунт</h1>
            <p className="text-sm text-muted">Зарегистрируйтесь по электронной почте и задайте пароль.</p>
          </div>
          <RegisterForm />
        </section>
      </Container>
    </main>
  );
}
