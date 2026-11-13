'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { register } from '../api/auth-api';
import { mapAuthError } from '../model/map-auth-error';

const INPUT_CLASS = 'w-full rounded-card border border-border bg-surface-raised px-3 py-2 text-sm';

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
        <h2 className="text-lg font-semibold">Проверьте почту</h2>
        <p className="text-sm text-muted">
          Аккаунт создан. Мы отправили письмо со ссылкой для подтверждения адреса и входа — она
          действует 15 минут.
        </p>
        <Link href="/" className="w-fit text-sm underline">
          На главную
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="register-email" className="text-sm font-medium">
          Электронная почта
        </label>
        <input
          id="register-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={INPUT_CLASS}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="register-password" className="text-sm font-medium">
          Пароль (не менее 10 символов)
        </label>
        <input
          id="register-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          maxLength={128}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={INPUT_CLASS}
        />
      </div>
      {error !== null ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="w-fit rounded-card bg-accent px-4 py-2 text-sm font-medium text-surface disabled:opacity-60"
      >
        {pending ? 'Создаём аккаунт…' : 'Зарегистрироваться'}
      </button>
      <p className="text-sm text-muted">
        Уже есть аккаунт?{' '}
        <Link href="/login" className="underline">
          Войти
        </Link>
      </p>
    </form>
  );
}
