import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'ghost';
type ButtonSize = 'md' | 'sm';

type CommonProps = {
  children: ReactNode;
  variant?: ButtonVariant;
  /** `md` — 48 px по высоте для страниц, `sm` — 38 px для действий внутри карточки. */
  size?: ButtonSize;
  className?: string;
};

type ButtonProps = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'> & {
    /** Если задан — рендерим ссылку (навигация без JS), иначе кнопку с действием. */
    href?: never;
  };

type ButtonLinkProps = CommonProps & {
  href: string;
  /** Доступное имя, если текст ссылки не описывает действие сам по себе. */
  ariaLabel?: string;
};

/**
 * Единственная кнопка системы (#13): заливка `ink` с переходом в `accent` на hover.
 * Ссылка и кнопка различаются по `href`: навигация остаётся ссылкой, действие — кнопкой.
 * Тап-таргет ≥ 44 px по высоте (py-3 при text-sm).
 */
const base =
  'inline-flex w-fit items-center justify-center gap-2 rounded-card border text-sm font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50';

const sizes: Record<ButtonSize, string> = {
  md: 'px-5 py-3',
  sm: 'px-4 py-2',
};

const variants: Record<ButtonVariant, string> = {
  primary:
    'border-ink bg-ink text-surface hover:border-accent hover:bg-accent hover:text-on-accent',
  ghost: 'border-border bg-transparent text-ink hover:border-ink',
};

function classes(variant: ButtonVariant, size: ButtonSize, className?: string): string {
  return [base, sizes[size], variants[variant], className].filter(Boolean).join(' ');
}

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  className,
  ...rest
}: ButtonProps) {
  return (
    <button type="button" className={classes(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}

export function ButtonLink({
  children,
  variant = 'primary',
  size = 'md',
  className,
  href,
  ariaLabel,
}: ButtonLinkProps) {
  return (
    <Link href={href} aria-label={ariaLabel} className={classes(variant, size, className)}>
      {children}
    </Link>
  );
}
