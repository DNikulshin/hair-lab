'use client';

import Link from 'next/link';
import { emailSchema } from '@hair-lab/contracts';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/shared/ui/button';
import { Field, TextInput } from '@/shared/ui/field';
import { login, requestMagicLink } from '../api/auth-api';
import { mapAuthError } from '../model/map-auth-error';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [magicError, setMagicError] = useState<string | null>(null);
  const [magicSent, setMagicSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [magicPending, setMagicPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await login({ email, password });
    setPending(false);
    if (!result.ok) {
      setError(mapAuthError(result.failure));
      return;
    }
    router.replace('/');
    router.refresh();
  }

  async function sendMagicLink() {
    if (magicPending) return;
    if (!emailSchema.safeParse(email).success) {
      setMagicSent(false);
      setMagicError('Введите корректный адрес электронной почты.');
      return;
    }
    setMagicPending(true);
    setMagicError(null);
    setMagicSent(false);
    const result = await requestMagicLink(email);
    setMagicPending(false);
    if (!result.ok) {
      setMagicError(mapAuthError(result.failure));
      return;
    }
    setMagicSent(true);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <Field label="Электронная почта">
        {(control) => (
          <TextInput
            {...control}
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        )}
      </Field>

      <Field label="Пароль">
        {(control) => (
          <TextInput
            {...control}
            name="password"
            type="password"
            autoComplete="current-password"
            required
            minLength={10}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </Field>

      {error !== null ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Входим…' : 'Войти по паролю'}
      </Button>

      <div className="flex flex-col gap-3 border-t border-border pt-5">
        <h2 className="text-base font-medium text-ink">Или войдите по ссылке</h2>
        <p className="text-sm text-muted">
          Мы отправим одноразовую ссылку, если для этого адреса можно выполнить вход.
        </p>
        {magicSent ? (
          <p role="status" className="text-sm text-muted">
            Если адрес зарегистрирован, письмо со ссылкой уже отправлено. Проверьте почту.
          </p>
        ) : null}
        {magicError !== null ? (
          <p role="alert" className="text-sm text-danger">
            {magicError}
          </p>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          disabled={magicPending}
          onClick={() => void sendMagicLink()}
        >
          {magicPending ? 'Отправляем…' : 'Отправить ссылку'}
        </Button>
      </div>

      <p className="text-sm text-muted">
        Нет аккаунта?{' '}
        <Link href="/register" className="underline hover:text-accent">
          Зарегистрироваться
        </Link>
      </p>
    </form>
  );
}
