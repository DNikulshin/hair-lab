import type { ReactNode } from 'react';

type SectionProps = {
  /** Заголовок секции; без него секция рендерится без `h2` (например, hero). */
  title?: string;
  description?: string;
  /** Ссылка или кнопка справа от заголовка (например, «Все услуги и цены»). */
  action?: ReactNode;
  /** id для `aria-labelledby`: связываем секцию с её заголовком. */
  id?: string;
  className?: string;
  children: ReactNode;
};

/**
 * Секция страницы: единый ритм заголовков и отступов (#13).
 * Заголовок — дисплейный `h2`; связь заголовка с секцией обязательна для скринридеров.
 */
export function Section({ title, description, action, id, className, children }: SectionProps) {
  const headingId = title && id ? `${id}-heading` : undefined;

  return (
    <section
      {...(title ? { 'aria-labelledby': headingId } : {})}
      className={['flex flex-col gap-5', className].filter(Boolean).join(' ')}
    >
      {title ? (
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 id={headingId} className="text-2xl font-light sm:text-[28px]">
              {title}
            </h2>
            {description ? <p className="max-w-2xl text-sm text-muted">{description}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}
