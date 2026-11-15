import type { Service } from '@hair-lab/contracts';
import { formatMinutes } from '../model/format';

type DurationBarProps = {
  /** Длительность услуги в минутах. */
  minutes: number;
  /** Максимум по каталогу: шкала сравнивает услуги между собой, а не показывает абсолют. */
  maxMinutes: number;
};

/**
 * Штрих длительности (#13): длина пропорциональна длительности относительно самой долгой
 * услуги каталога. Смысл — сравнение внутри списка, поэтому шкала относительная.
 * Для скринридера значение дублируется текстом рядом с полосой.
 */
export function DurationBar({ minutes, maxMinutes }: DurationBarProps) {
  const share = maxMinutes > 0 ? Math.min(1, minutes / maxMinutes) : 0;
  const width = `${Math.max(6, Math.round(share * 100))}%`;

  return (
    <div
      className="flex items-center gap-2.5 whitespace-nowrap text-xs text-muted"
      aria-hidden="true"
    >
      <span className="relative h-1.5 w-24 overflow-hidden bg-border sm:w-32">
        <span className="absolute inset-y-0 left-0 bg-ink" style={{ width }} />
      </span>
      <span className="tabular-nums">{formatMinutes(minutes)}</span>
    </div>
  );
}

/** Максимальная длительность в каталоге — база для относительной шкалы. */
export function maxDuration(services: Service[]): number {
  return services.reduce((max, service) => Math.max(max, service.durationMin), 0);
}
