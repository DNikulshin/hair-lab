'use client';

import { useEffect, useState } from 'react';
import { formatClock, formatDeployMoment, type DeployEnv } from '@/shared/config/deploy';

type DeployBadgeProps = {
  env: DeployEnv;
  /** Короткий sha задеплоенного коммита. */
  sha: string | null;
  /** Момент деплоя в ISO-8601 (передаётся строкой: так значение стабильно при гидрации). */
  deployedAt: string | null;
};

/**
 * Плашка стенда: окружение и идущие часы (issue #170).
 *
 * Живёт поверх страницы (`fixed`) и не участвует в разметке, поэтому ничего не сдвигает.
 * `pointer-events-none` — клики и тапы проходят насквозь, плашка не перекрывает навигацию
 * и кнопки под ней. Скрыта при печати.
 *
 * Часы: на сервере и при первой гидрации показывается время деплоя (значение из пропсов —
 * оно одинаково на сервере и клиенте, поэтому расхождения при гидрации нет), после монтирования
 * стартует интервал и в плашке идёт текущее время — по нему видно, что страница живая.
 */
export function DeployBadge({ env, sha, deployedAt }: DeployBadgeProps) {
  const deployed = deployedAt === null ? null : new Date(deployedAt);
  const [now, setNow] = useState<Date | null>(deployed);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      role="note"
      aria-label={`Стенд ${env}`}
      className="pointer-events-none fixed left-2 top-2 z-50 select-none rounded-card border border-border bg-surface-raised/90 px-2 py-1 font-mono text-[10px] leading-tight text-muted shadow-sm print:hidden"
    >
      <div className="flex items-baseline gap-1.5">
        <span className="font-semibold uppercase tracking-wide text-accent">{env}</span>
        <span className="tabular-nums text-ink">{now === null ? '—' : formatClock(now)}</span>
      </div>
      <div className="tabular-nums">
        {sha === null ? null : <span>{sha}</span>}
        {deployed === null ? null : (
          <span>
            {sha === null ? '' : ' · '}
            деплой {formatDeployMoment(deployed)}
          </span>
        )}
      </div>
    </div>
  );
}
