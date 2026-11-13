import type { Service } from '@hair-lab/contracts';
import { formatDuration, formatPrice } from '../model/format';
import { BookButton } from './book-button';

type ServiceCardProps = {
  service: Service;
};

/** Карточка услуги: название, описание, цена и длительность, заглушка онлайн-записи. */
export function ServiceCard({ service }: ServiceCardProps) {
  return (
    <article className="flex h-full flex-col gap-3 rounded-card border border-border bg-surface-raised p-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-medium">{service.name}</h3>
        {service.description ? <p className="text-sm text-muted">{service.description}</p> : null}
      </div>
      <p className="mt-auto flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="text-base font-medium">{formatPrice(service.price.amountMinor)}</span>
        <span className="text-muted">{formatDuration(service.durationMin)}</span>
      </p>
      <BookButton idSuffix={service.id} />
    </article>
  );
}
