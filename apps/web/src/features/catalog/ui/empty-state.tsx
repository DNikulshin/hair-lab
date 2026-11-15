import { siteConfig } from '@/shared/config/site';
import { Card } from '@/shared/ui/card';

type EmptyStateVariant = 'empty' | 'unavailable';

type EmptyStateProps = {
  variant: EmptyStateVariant;
};

/**
 * Состояние витрины вместо списка. Два разных смысла:
 * - `empty` — API ответил, но каталог пуст (данные ещё не завели);
 * - `unavailable` — данные получить не удалось (API недоступен или ответ не по контракту).
 * Телефон салона показываем только если он задан в окружении.
 */
const content: Record<EmptyStateVariant, { title: string; description: string }> = {
  empty: {
    title: 'Каталог пока пуст',
    description: 'Мы обновляем прайс и состав мастеров. Загляните чуть позже.',
  },
  unavailable: {
    title: 'Каталог временно недоступен',
    description: 'Не удалось загрузить услуги и цены. Позвоните нам — подскажем и запишем.',
  },
};

export function EmptyState({ variant }: EmptyStateProps) {
  const { title, description } = content[variant];
  const phone = siteConfig.phone;
  const phoneHref = phone ? `tel:${phone.replace(/[^+\d]/g, '')}` : undefined;

  return (
    <Card tone="plain" className="max-w-2xl">
      <h2 className="text-xl font-light">{title}</h2>
      <p className="text-sm text-muted">{description}</p>
      {variant === 'unavailable' && phone && phoneHref ? (
        <p className="text-sm">
          <a href={phoneHref} className="font-medium underline hover:text-accent">
            {phone}
          </a>
        </p>
      ) : null}
    </Card>
  );
}
