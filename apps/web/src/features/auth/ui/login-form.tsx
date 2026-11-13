'use client';

import Link from 'next/link';
import { emailSchema } from '@hair-lab/contracts';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { login, requestMagicLink } from '../api/auth-api';
import { mapAuthError } from '../model/map-auth-error';

const INPUT_CLASS = 'w-full rounded-card border border-border bg-surface-raised px-3 py-2 text-sm';

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
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="login-email" className="text-sm font-medium">
          Электронная почта
        </label>
        <input
          id="login-email"
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
        <label htmlFor="login-password" className="text-sm font-medium">
          Пароль
        </label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
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
        {pending ? 'Входим…' : 'Войти по паролю'}
      </button>
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <h2 className="text-base font-semibold">Или войдите по ссылке</h2>
        <p className="text-sm text-muted">
          Мы отправим одноразовую ссылку, если для этого адреса можно выполнить вход.
        </p>
        {magicSent ? (
          <p role="status" className="text-sm text-muted">
            Если адрес зарегистрирован, письмо со ссылкой уже отправлено. Проверьте почту.
          </p>
        ) : null}
        {magicError !== null ? (
          <p role="alert" className="text-sm text-red-600">
            {magicError}
          </p>
        ) : null}
        <button
          type="button"
          disabled={magicPending}
          onClick={() => void sendMagicLink()}
          className="w-fit rounded-card border border-border px-4 py-2 text-sm font-medium disabled:opacity-60"
        >
          {magicPending ? 'Отправляем…' : 'Отправить ссылку'}
        </button>
      </div>
      <p className="text-sm text-muted">
        Нет аккаунта?{' '}
        <Link href="/register" className="underline">
          Зарегистрироваться
        </Link>
      </p>
    </form>
  );
}
