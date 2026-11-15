'use client';

import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

type FieldProps = {
  label: string;
  /** Текст ошибки: показываем под контролом и связываем через `aria-describedby`. */
  error?: string;
  hint?: string;
  /** Явный id контрола; без него Field и контрол свяжутся автоматически (см. FieldControl). */
  id?: string;
  children: ReactNode;
};

/**
 * Поле формы (#13): подпись сверху, подчёркивание вместо рамки, ошибка — цветом акцента
 * и текстом, а не только цветом. Ошибка не повторяет введённое значение.
 */
export function Field({ label, error, hint, id, children }: FieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const errorId = `${fieldId}-error`;
  const hintId = `${fieldId}-hint`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-xs text-muted">
        {label}
      </label>
      {children}
      {hint && !error ? (
        <span id={hintId} className="text-xs text-muted">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="text-xs text-accent">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Подчёркнутый инпут: граница `ink` даёт контраст ≥ 3:1, фокус — акцентная обводка. */
const controlClasses =
  'w-full rounded-none border-0 border-b border-ink bg-transparent px-0 py-2 text-base text-ink placeholder:text-muted';

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={[controlClasses, className].filter(Boolean).join(' ')} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={[controlClasses, className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </select>
  );
}
