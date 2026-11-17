'use client';

import { staffLoginRequestSchema, type StaffAccount } from '@hair-lab/contracts';
import { useState, type FormEvent } from 'react';
import { Button } from '@/shared/ui/button';
import { Field, TextInput } from '@/shared/ui/field';
import { loginStaff } from '../api/admin-api';
import { mapStaffLoginError } from '../model/map-admin-error';

/**
 * Вход сотрудника в админку: почта и пароль.
 *
 * Форма отдельная от клиентского `/login`: это другая учётная запись и другая cookie
 * (`hl_staff_session`). Ввод проверяется тем же контрактом, что и в API, поэтому заведомо
 * неверные данные не доходят до сети.
 *
 * Защита от двойной отправки: кнопка disabled и guard `if (pending) return` — второй клик
 * во время запроса не создаёт второй запрос (иначе ограничение попыток сработало бы зря).
 *
 * ПДн: пароль живёт только в состоянии формы, никуда не пишется и не логируется; текст
 * ошибки — нейтральный, по нему нельзя узнать, существует ли учётная запись.
 */

export interface StaffLoginFormProps {
  /** Успешный вход: экран переключается на записи дня без перезагрузки страницы. */
  onSuccess: (staff: StaffAccount) => void;
}

export function StaffLoginForm({ onSuccess }: StaffLoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const parsed = staffLoginRequestSchema.safeParse({ email, password });
    if (!parsed.success) {
      setError('Проверьте адрес почты и пароль.');
      return;
    }

    setPending(true);
    setError(null);
    const result = await loginStaff(parsed.data);
    setPending(false);

    if (!result.ok) {
      setError(mapStaffLoginError(result.failure));
      return;
    }

    // Пароль в состоянии не держим после входа.
    setPassword('');
    onSuccess(result.data);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" aria-label="Вход сотрудника">
      <Field label="Рабочая почта">
        {(control) => (
          <TextInput
            {...control}
            name="email"
            type="email"
            autoComplete="username"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={pending}
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
            disabled={pending}
          />
        )}
      </Field>

      {error !== null ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Входим…' : 'Войти'}
      </Button>
    </form>
  );
}
