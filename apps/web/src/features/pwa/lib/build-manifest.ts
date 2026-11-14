import type { MetadataRoute } from 'next';
import { siteConfig } from '@/shared/config/site';

/**
 * Web App Manifest как чистая функция от базы: собирается в `app/manifest.ts`
 * (Next отдаёт его по `/manifest.webmanifest` и сам вставляет `<link rel="manifest">`,
 * учитывая basePath).
 *
 * Тексты берутся из `siteConfig` — единственного источника названия и описания,
 * поэтому манифест меняется вместе с сайтом, без правки кода.
 */

/** Фон и тема — светлая поверхность из дизайн-токенов (`--surface`, `globals.css`). */
export const PWA_BACKGROUND_COLOR = '#faf8f5';
export const PWA_THEME_COLOR = '#faf8f5';

/** Доли источника: `base` — нормализованный префикс (`''` в проде, `/p` за dev-прокси). */
export function buildManifest(base: string): MetadataRoute.Manifest {
  return {
    name: siteConfig.name,
    short_name: siteConfig.shortName,
    description: siteConfig.description,
    start_url: `${base}/`,
    scope: `${base}/`,
    display: 'standalone',
    // `siteConfig.locale` — 'ru-RU'; язык фиксируем по конфигу, а не по Accept-Language.
    lang: siteConfig.locale,
    background_color: PWA_BACKGROUND_COLOR,
    theme_color: PWA_THEME_COLOR,
    icons: [
      { src: `${base}/icons/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: `${base}/icons/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: `${base}/icons/icon-maskable-512.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
