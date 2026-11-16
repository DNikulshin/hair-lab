'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatClock, formatDeployMoment, type DeployEnv } from '@/shared/config/deploy';
import {
  clampPosition,
  DEFAULT_POSITION,
  isDragGesture,
  parseStoredPosition,
  POSITION_STORAGE_KEY,
  serializePosition,
  type BadgePosition,
} from '@/shared/ui/deploy-badge-position';

type DeployBadgeProps = {
  env: DeployEnv;
  /** Короткий sha задеплоенного коммита. */
  sha: string | null;
  /** Момент деплоя в ISO-8601 (передаётся строкой: так значение стабильно при гидрации). */
  deployedAt: string | null;
};

/** Сколько держать раскрытые детали после тапа. */
const EXPANDED_MS = 8000;
/** Через сколько секунд без взаимодействия плашка притухает. */
const IDLE_MS = 5000;
/** Прозрачность в покое: видно, но не отвлекает. */
const IDLE_OPACITY = 'opacity-40';
/** Размеры для прижатия к краю, если `getBoundingClientRect` ещё недоступен (первый рендер). */
const FALLBACK_SIZE = { width: 160, height: 20 };

/**
 * Плашка стенда: окружение, часы, sha и время деплоя (issue #170, доработка #176).
 *
 * Поведение: по умолчанию свёрнута в одну строку с пульсирующей точкой и часами; тап/клик/Enter
 * раскрывают детали на 8 секунд; плашку можно утащить мышью или пальцем, позиция запоминается
 * в `localStorage`; через 5 секунд покоя она притухает, при наведении и фокусе снова полная.
 *
 * Почему `fixed`: разметку это не трогает — элемент вне потока, страница не сдвигается.
 * В отличие от первой версии, плашка ловит указатель (её надо тащить и нажимать), поэтому
 * занимает только свою площадь: `pointer-events` стоит на самой кнопке, остальное прозрачно.
 *
 * Часы: на сервере и при первой гидрации показывается время деплоя (значение из пропсов —
 * одинаково на сервере и клиенте), после монтирования стартует интервал.
 */
export function DeployBadge({ env, sha, deployedAt }: DeployBadgeProps) {
  const deployed = deployedAt === null ? null : new Date(deployedAt);
  const [now, setNow] = useState<Date | null>(deployed);
  const [expanded, setExpanded] = useState(false);
  const [idle, setIdle] = useState(false);
  // Позиция читается из хранилища после монтирования: на сервере её нет, иначе гидрация разошлась бы.
  const [position, setPosition] = useState<BadgePosition>(DEFAULT_POSITION);
  const badgeRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: BadgePosition;
    moved: boolean;
  } | null>(null);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Текущий размер плашки — нужен для прижатия к краям. */
  const measuredSize = useCallback(() => {
    const rect = badgeRef.current?.getBoundingClientRect();
    return rect ? { width: rect.width, height: rect.height } : FALLBACK_SIZE;
  }, []);

  /** Прижимает позицию к окну (вызывается после переезда, раскрытия и ресайза). */
  const reclamp = useCallback(
    (desired: BadgePosition) =>
      clampPosition(
        desired,
        { width: window.innerWidth, height: window.innerHeight },
        measuredSize(),
      ),
    [measuredSize],
  );

  // Часы: тикают каждую секунду, пока страница открыта.
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Восстановление позиции и прижатие при изменении размера окна.
  useEffect(() => {
    const readStored = (): BadgePosition | null => {
      try {
        return parseStoredPosition(window.localStorage.getItem(POSITION_STORAGE_KEY));
      } catch {
        return null; // приватный режим и подобное — работаем с позицией по умолчанию
      }
    };
    setPosition(reclamp(readStored() ?? DEFAULT_POSITION));

    const onResize = () => setPosition((current) => reclamp(current));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [reclamp]);

  // Притухание через IDLE_MS без взаимодействия.
  const touchIdle = useCallback(() => {
    setIdle(false);
    if (idleTimer.current !== null) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), IDLE_MS);
  }, []);

  useEffect(() => {
    touchIdle();
    return () => {
      if (idleTimer.current !== null) clearTimeout(idleTimer.current);
      if (collapseTimer.current !== null) clearTimeout(collapseTimer.current);
    };
  }, [touchIdle]);

  // Раскрытие меняет размер — позицию надо пересчитать, иначе плашка вылезет за край.
  useEffect(() => {
    setPosition((current) => reclamp(current));
    if (!expanded) return;
    if (collapseTimer.current !== null) clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(() => setExpanded(false), EXPANDED_MS);
    return () => {
      if (collapseTimer.current !== null) clearTimeout(collapseTimer.current);
    };
  }, [expanded, reclamp]);

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return; // правая кнопка и middle не тащат плашку
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: position,
      moved: false,
    };
    badgeRef.current?.setPointerCapture(event.pointerId);
    touchIdle();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && !isDragGesture(dx, dy)) return; // дрожание пальца — ещё не перетаскивание
    drag.moved = true;
    setPosition(reclamp({ x: drag.origin.x + dx, y: drag.origin.y + dy }));
  };

  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    badgeRef.current?.releasePointerCapture(event.pointerId);

    if (drag.moved) {
      // Перетащили: новую позицию запоминаем и раскрытие не переключаем.
      setPosition((current) => {
        try {
          window.localStorage.setItem(POSITION_STORAGE_KEY, serializePosition(current));
        } catch {
          // Хранилище недоступно — позиция просто не переживёт перезагрузку.
        }
        return current;
      });
      return;
    }
    setExpanded((value) => !value); // это был клик: раскрыть/свернуть
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setExpanded((value) => !value);
  };

  const deployMoment = deployed === null ? null : formatDeployMoment(deployed);

  return (
    <button
      ref={badgeRef}
      type="button"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setIdle(false)}
      onFocus={() => setIdle(false)}
      onBlur={touchIdle}
      aria-expanded={expanded}
      aria-label={`Стенд ${env}. ${expanded ? 'Свернуть детали' : 'Показать детали деплоя'}. Плашку можно перетащить.`}
      title="Перетащите, чтобы переместить. Нажмите, чтобы показать детали деплоя"
      style={{ left: position.x, top: position.y }}
      className={[
        'fixed z-50 flex cursor-grab touch-none select-none flex-col gap-0.5 rounded-card border border-border bg-surface-raised/90 px-2 py-1 text-left font-mono text-[10px] leading-tight text-muted shadow-sm transition-opacity duration-300 print:hidden active:cursor-grabbing',
        idle && !expanded ? IDLE_OPACITY : 'opacity-100',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="flex items-baseline gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse self-center rounded-full bg-accent"
        />
        <span className="font-semibold uppercase tracking-wide text-accent">{env}</span>
        <span className="tabular-nums text-ink">{now === null ? '—' : formatClock(now)}</span>
      </span>
      {expanded ? (
        <span className="tabular-nums">
          {sha === null ? null : <span>{sha}</span>}
          {deployMoment === null ? null : (
            <span>
              {sha === null ? '' : ' · '}
              деплой {deployMoment}
            </span>
          )}
        </span>
      ) : null}
    </button>
  );
}
