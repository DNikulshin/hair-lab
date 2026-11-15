import type { Metadata } from 'next';
import { LoginForm } from '@/features/auth';
import { Card } from '@/shared/ui/card';
import { Container } from '@/shared/ui/container';

export const metadata: Metadata = { title: 'Войти' };

export default function LoginPage() {
  return (
    <main>
      <Container className="max-w-lg py-12 sm:py-16">
        <Card className="gap-6 p-6">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-light">Вход</h1>
            <p className="text-sm text-muted">
              Войдите по паролю или запросите одноразовую ссылку на почту.
            </p>
          </div>
          <LoginForm />
        </Card>
      </Container>
    </main>
  );
}
