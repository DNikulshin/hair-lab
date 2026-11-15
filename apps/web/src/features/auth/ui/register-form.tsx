'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button } from '@/shared/ui/button';
import { Field, TextInput } from '@/shared/ui/field';
import { register } from '../api/auth-api';
import { mapAuthError } from '../model/map-auth-error';

export function RegisterForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await register({ email, password });
    setPending(false);
    if (!result.ok) {
      setError(mapAuthError(result.failure));
      return;
    }
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="flex flex-col gap-3" role="status">
        <h2 className="text-lg font-medium">Проверьте почту</h2>
        <p className="text-sm text-muted">
          Аккаунт создан. Мы отправили письмо со ссылкой для подтверждения адреса и входа — она
          действует 15 минут.
        </p>
        <Link href="/" className="w-fit text-sm underline hover:text-accent">
          На главную
        </Link>
      </div>
    );
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

      <Field label="Пароль" hint="Не менее 10 символов.">
        {(control) => (
          <TextInput
            {...control}
            name="password"
            type="password"
            autoComplete="new-password"
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
        {pending ? 'Создаём аккаунт…' : 'Зарегистрироваться'}
      </Button>

      <p className="text-sm text-muted">
        Уже есть аккаунт?{' '}
        <Link href="/login" className="underline hover:text-accent">
          Войти
        </Link>
      </p>
    </form>
  );
}
