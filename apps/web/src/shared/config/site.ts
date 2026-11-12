/**
 * Публичные настройки сайта. Значения приходят из окружения, чтобы один и тот же
 * образ работал на разных доменах (см. `.env.example`).
 *
 * Внимание: переменные с префиксом NEXT_PUBLIC_ встраиваются в бандл на этапе сборки,
 * поэтому для Docker-образа они передаются build-args. Секретов здесь быть не может.
 */
function requiredOrFallback(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export const siteConfig = {
  name: requiredOrFallback(process.env.NEXT_PUBLIC_SITE_NAME, 'Стриж Lab'),
  shortName: requiredOrFallback(process.env.NEXT_PUBLIC_SITE_SHORT_NAME, 'Стриж'),
  description: requiredOrFallback(
    process.env.NEXT_PUBLIC_SITE_DESCRIPTION,
    'Салон красоты в Москве: услуги, мастера и онлайн-запись.',
  ),
  /** Канонический адрес: используется в metadataBase и ссылках. */
  url: requiredOrFallback(process.env.NEXT_PUBLIC_SITE_URL, 'https://strizhlab.ru'),
  city: requiredOrFallback(process.env.NEXT_PUBLIC_SITE_CITY, 'Москва'),
  locale: 'ru-RU',
  timeZone: requiredOrFallback(process.env.NEXT_PUBLIC_SITE_TIMEZONE, 'Europe/Moscow'),
  apiUrl: requiredOrFallback(process.env.NEXT_PUBLIC_API_URL, 'http://localhost:3001'),
} as const;

export type SiteConfig = typeof siteConfig;
