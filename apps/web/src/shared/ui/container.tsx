import type { ReactNode } from 'react';

type ContainerProps = {
  children: ReactNode;
  className?: string;
};

/** Горизонтальная сетка контента: отступы и максимальная ширина. */
export function Container({ children, className }: ContainerProps) {
  return (
    <div className={['mx-auto w-full max-w-6xl px-5', className].filter(Boolean).join(' ')}>
      {children}
    </div>
  );
}
