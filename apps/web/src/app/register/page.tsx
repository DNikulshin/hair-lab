import type { Metadata } from 'next';
import { RegisterForm } from '@/features/auth';
import { Card } from '@/shared/ui/card';
import { Container } from '@/shared/ui/container';

export const metadata: Metadata = { title: 'Регистрация' };

export default function RegisterPage() {
  return (
    <main>
      <Container className="max-w-lg py-12 sm:py-16">
        <Card className="gap-6 p-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-light">Создать аккаунт</h1>
            <p className="text-sm text-muted">
              Зарегистрируйтесь по электронной почте и задайте пароль.
            </p>
          </div>
          <RegisterForm />
        </Card>
      </Container>
    </main>
  );
}
