import type { ReactNode } from 'react';

type CardProps = {
  /** `raised` — карточка на фоне страницы; `plain` — только линейка, без заливки. */
  tone?: 'raised' | 'plain';
  className?: string;
  children: ReactNode;
};

/**
 * Карточка системы (#13): волосяная рамка и скругление 12 px, без теней.
 * Иерархию задаёт заливка `surface-raised` и размер кегля, а не тень.
 */
const tones = {
  raised: 'bg-surface-raised',
  plain: 'bg-transparent',
} as const;

export function Card({ tone = 'raised', className, children }: CardProps) {
  return (
    <div
      className={[
        'flex h-full flex-col gap-3 rounded-card border border-border p-5',
        tones[tone],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  );
}
