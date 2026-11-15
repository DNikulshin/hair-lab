import type { Service } from '@hair-lab/contracts';
import { Card } from '@/shared/ui/card';
import { formatPrice } from '../model/format';
import { BookButton } from './book-button';
import { DurationBar } from './duration-bar';

type ServiceCardProps = {
  service: Service;
  /** База относительной шкалы длительности: самая долгая услуга каталога. */
  maxMinutes: number;
};

/** Карточка услуги: название, описание, цена и штрих длительности, переход к записи. */
export function ServiceCard({ service, maxMinutes }: ServiceCardProps) {
  return (
    <Card>
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-medium tracking-normal">{service.name}</h3>
        {service.description ? <p className="text-sm text-muted">{service.description}</p> : null}
      </div>
      <div className="mt-auto flex flex-wrap items-baseline justify-between gap-3 pt-1">
        <DurationBar minutes={service.durationMin} maxMinutes={maxMinutes} />
        <span className="font-display text-xl font-light">
          {formatPrice(service.price.amountMinor)}
        </span>
      </div>
      <BookButton serviceId={service.id} serviceName={service.name} />
    </Card>
  );
}
