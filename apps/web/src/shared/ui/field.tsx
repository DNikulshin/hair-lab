'use client';

import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes } from 'react';

type FieldControlProps = {
  id: string;
  'aria-invalid': boolean;
  'aria-describedby': string | undefined;
};

type FieldProps = {
  label: string;
  /** Текст ошибки: показывается под контролом и связывается с ним через `aria-describedby`. */
  error?: string | undefined;
  hint?: string;
  /** Явный id контрола; без него генерируется стабильный. */
  id?: string;
  /** Контрол получает id и aria-атрибуты готовыми — вручную связывать ничего не нужно. */
  children: (control: FieldControlProps) => ReactNode;
};

/**
 * Поле формы (#13): подпись сверху, подчёркивание вместо рамки, ошибка — текстом и цветом.
 *
 * Контрол приходит функцией, а не элементом: так `id`/`aria-invalid`/`aria-describedby`
 * не приходится дублировать в каждом поле, и связь подписи с контролом не расходится.
 */
export function Field({ label, error, hint, id, children }: FieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-xs text-muted">
        {label}
      </label>
      {children({
        id: fieldId,
        'aria-invalid': error !== undefined,
        'aria-describedby': describedBy,
      })}
      {hint && !error ? (
        <span id={hintId} className="text-xs text-muted">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="text-xs text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Подчёркнутый инпут: линия `ink` даёт контраст ≥ 3:1 (требование к границам контролов),
 * фокус — акцентная обводка из базового слоя.
 */
const controlClasses =
  'w-full rounded-none border-0 border-b border-ink bg-transparent px-0 py-2 text-base text-ink placeholder:text-muted aria-[invalid=true]:border-danger';

/**
 * `ref` принимаем обычным пропом: в React 19 он для функциональных компонентов больше не
 * отдельный механизм, и проброс `{...rest}` доходит до `<input>` (нужно визарду записи,
 * который переводит фокус на первое ошибочное поле).
 */
type TextInputProps = InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> };

export function TextInput({ className, ...rest }: TextInputProps) {
  return <input className={[controlClasses, className].filter(Boolean).join(' ')} {...rest} />;
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> };

export function Select({ className, children, ...rest }: SelectProps) {
  return (
    <select className={[controlClasses, className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </select>
  );
}
