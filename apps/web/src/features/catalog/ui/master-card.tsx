import type { Master } from '@hair-lab/contracts';
import { Card } from '@/shared/ui/card';
import { formatPrice } from '../model/format';

/** Инициалы для заглушки фото: первые буквы первых двух слов имени. */
function initials(fullName: string): string {
  return fullName
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

type MasterCardProps = {
  master: Master;
};

/**
 * Карточка мастера: имя, описание и услуги с ценами.
 * Фото — обычный `<img>`: домены для `next/image` появятся вместе с загрузкой фото (follow-up).
 */
export function MasterCard({ master }: MasterCardProps) {
  return (
    <Card className="gap-4">
      <div className="flex items-center gap-4">
        {master.photoUrl ? (
          <img
            src={master.photoUrl}
            alt={`Фото: ${master.fullName}`}
            width={56}
            height={56}
            className="size-14 shrink-0 rounded-full border border-border object-cover"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex size-14 shrink-0 items-center justify-center rounded-full border border-border font-display text-sm text-muted"
          >
            {initials(master.fullName)}
          </div>
        )}
        <h3 className="text-lg font-medium tracking-normal">{master.fullName}</h3>
      </div>

      {master.bio ? <p className="text-sm text-muted">{master.bio}</p> : null}

      {master.services.length > 0 ? (
        <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
          <h4 className="text-xs text-muted">Услуги мастера</h4>
          <ul className="flex flex-col gap-1.5 text-sm">
            {master.services.map((service) => (
              <li key={service.id} className="flex justify-between gap-3">
                <span>{service.name}</span>
                <span className="whitespace-nowrap text-muted">
                  {formatPrice(service.price.amountMinor)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
