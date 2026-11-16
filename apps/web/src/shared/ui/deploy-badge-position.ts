/**
 * Геометрия и память позиции плашки стенда (issue #176).
 *
 * Логика вынесена из компонента и не зависит от DOM: её проверяют тесты (`node`-окружение,
 * без jsdom). Компонент `deploy-badge.tsx` только применяет результат.
 */

/** Позиция левого верхнего угла плашки в пикселях от угла окна. */
export type BadgePosition = {
  x: number;
  y: number;
};

/** Размер плашки в пикселях (берётся из `getBoundingClientRect`). */
export type BadgeSize = {
  width: number;
  height: number;
};

/** Размер окна в пикселях. */
export type ViewportSize = {
  width: number;
  height: number;
};

/** Ключ в `localStorage`; версия в ключе — чтобы смена формата не ломала старые записи. */
export const POSITION_STORAGE_KEY = 'hair-lab:deploy-badge-position:v1';

/** Позиция по умолчанию: левый верхний угол, как в макете плашки. */
export const DEFAULT_POSITION: BadgePosition = { x: 8, y: 8 };

/** Минимальный отступ от края окна: плашка не должна прилипать вплотную. */
export const EDGE_MARGIN = 4;

/** Порог жеста: сдвиг меньше — это клик (раскрытие), больше — перетаскивание. */
export const DRAG_THRESHOLD = 6;

/**
 * Прижимает позицию к границам окна: плашка не уезжает за экран и не прячется под край.
 * Если окно меньше плашки, побеждает отступ от левого/верхнего края (иначе плашка
 * «прыгала» бы за пределы и её нельзя было бы вернуть).
 * @param desired желаемая позиция
 * @param viewport размер окна
 * @param size размер плашки
 * @param margin отступ от края
 * @returns позиция внутри окна
 */
export function clampPosition(
  desired: BadgePosition,
  viewport: ViewportSize,
  size: BadgeSize,
  margin: number = EDGE_MARGIN,
): BadgePosition {
  const maxX = viewport.width - size.width - margin;
  const maxY = viewport.height - size.height - margin;
  return {
    x: Math.max(margin, Math.min(desired.x, Math.max(margin, maxX))),
    y: Math.max(margin, Math.min(desired.y, Math.max(margin, maxY))),
  };
}

/**
 * Читает сохранённую позицию. Битое, чужое или неполное значение — `null`: плашка вернётся
 * в угол по умолчанию, а не окажется в случайной точке.
 * @param raw содержимое `localStorage`
 * @returns позиция или `null`
 */
export function parseStoredPosition(raw: string | null): BadgePosition | null {
  if (raw === null || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as { x?: unknown; y?: unknown };
  if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return null;
  return { x: Math.round(candidate.x as number), y: Math.round(candidate.y as number) };
}

/**
 * Сериализует позицию для `localStorage`.
 * @param position позиция плашки
 * @returns строка JSON
 */
export function serializePosition(position: BadgePosition): string {
  return JSON.stringify({ x: Math.round(position.x), y: Math.round(position.y) });
}

/**
 * Был ли это жест перетаскивания, а не клик.
 * @param dx смещение по X от начала нажатия
 * @param dy смещение по Y от начала нажатия
 * @param threshold порог в пикселях
 * @returns `true`, если сдвиг больше порога
 */
export function isDragGesture(dx: number, dy: number, threshold: number = DRAG_THRESHOLD): boolean {
  return Math.abs(dx) > threshold || Math.abs(dy) > threshold;
}
