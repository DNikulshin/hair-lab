/**
 * Форматирование значений витрины в русские подписи.
 *
 * Чистые функции без побочных эффектов: используются в Server Components и покрыты тестами.
 */

const priceFormatterCache = new Map<boolean, Intl.NumberFormat>();

/** Формат цены в рублях: копейки показываем только если они ненулевые. */
function priceFormatter(withKopecks: boolean): Intl.NumberFormat {
  const cached = priceFormatterCache.get(withKopecks);
  if (cached !== undefined) return cached;

  const formatter = new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    minimumFractionDigits: withKopecks ? 2 : 0,
    maximumFractionDigits: withKopecks ? 2 : 0,
  });
  priceFormatterCache.set(withKopecks, formatter);
  return formatter;
}

/**
 * Копейки → «2 500 ₽» (или «2 500,50 ₽», если копейки ненулевые).
 * Деньги в контрактах передаются в минимальных единицах — здесь единственное место,
 * где они превращаются в текст.
 */
export function formatPrice(amountMinor: number): string {
  const withKopecks = amountMinor % 100 !== 0;
  return priceFormatter(withKopecks).format(amountMinor / 100);
}

/**
 * Минуты → «45 мин», «1 ч 20 мин», «2 ч».
 * Нулевая и отрицательная длительность невозможна по контракту, но не роняем рендер.
 */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';

  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;

  if (hours === 0) return `${rest} мин`;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}
