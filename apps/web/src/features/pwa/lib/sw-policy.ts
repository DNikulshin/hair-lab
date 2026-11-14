/**
 * Политика service worker: что кэшируем, а что не отдаём из кэша никогда.
 *
 * Модуль чистый (никаких `self`, `caches`, DOM): тестируется в node. Правила
 * продублированы генератором исходника SW (`build-sw-source.ts`), который подставляет
 * отсюда константы — список исключений и версия кэшей меняются в одном месте.
 *
 * Инварианты (см. AGENTS.md, «Данные и надёжность»): ответы API и приватный HTML
 * (`/account`, `/login`, `/register`) не попадают в кэш ни при каких условиях;
 * HTML публичных страниц не прекешируем — он `force-dynamic`.
 */

/** Как service worker обрабатывает запрос. */
export type SwTarget = 'api' | 'private-html' | 'next-static' | 'asset' | 'other';

/**
 * Версия кэшей. Бамп **вручную** при любом изменении политики или содержимого SW:
 * в `activate` все кэши другой версии удаляются, поэтому старый HTML/скрипты
 * не переживают деплой.
 */
export const SW_CACHE_VERSION = 'v1';

/** Общий префикс: по нему `activate` узнаёт «свои» кэши. */
export const SW_CACHE_PREFIX = 'hair-lab';

/** Кэш предзагрузки: офлайн-страница и иконки. */
export const PRECACHE_CACHE = `${SW_CACHE_PREFIX}-precache-${SW_CACHE_VERSION}`;

/** Runtime-кэш: навигации публичных страниц, `/_next/static/**`, картинки. */
export const RUNTIME_CACHE = `${SW_CACHE_PREFIX}-runtime-${SW_CACHE_VERSION}`;

/** Кэши текущей версии — всё остальное `activate` удаляет. */
export const SW_CACHE_NAMES = [PRECACHE_CACHE, RUNTIME_CACHE] as const;

/**
 * Пути без базы, которые кладём в кэш при установке SW.
 *
 * HTML публичных страниц здесь намеренно нет: они рендерятся динамически
 * (`force-dynamic`), кэш устаревал бы после каждого деплоя данных.
 */
export const PRECACHE_PATHS = [
  '/offline',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
] as const;

/** Офлайн-страница: отдаётся, когда сети нет. */
export const OFFLINE_PATH = '/offline';

/**
 * Приватные разделы: только сеть. Кэшированный приватный HTML не отдаём никогда —
 * на общем устройстве он показал бы чужие данные. `/login/magic` покрыт префиксом
 * `/login`, но перечислен явно: это точка входа с токеном из письма.
 */
export const PRIVATE_HTML_PREFIXES = ['/account', '/login', '/login/magic', '/register'] as const;

/** Прокси к API: passthrough, ни `respondWith`, ни `cache.put`. */
export const API_PREFIX = '/api/';

/** Хэшированная статика Next: cache-first. */
export const NEXT_STATIC_PREFIX = '/_next/static/';

/** Расширения картинок и иконок: stale-while-revalidate. */
export const ASSET_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'avif',
  'svg',
  'gif',
  'ico',
] as const;

/** Таймаут сети для навигации: дольше ждать на плохом мобильном интернете бессмысленно. */
export const NAV_TIMEOUT_MS = 4000;

/** Путь с префиксом базы: `withBase('/offline', '/p')` → `/p/offline`. */
export function withBase(path: string, base: string): string {
  return `${base}${path}`;
}

/** Отрезает базу от пути: `/p/account` при базе `/p` → `/account`. */
function stripBase(pathname: string, base: string): string {
  if (!base) return pathname;
  if (pathname === base) return '/';
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length);
  return pathname;
}

/** Совпадает с разделом или вложенным путём внутри него: `/account` и `/account/x`. */
function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isAssetPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  const extension = path.slice(dot + 1).toLowerCase();
  return (ASSET_EXTENSIONS as readonly string[]).includes(extension);
}

/**
 * Категория запроса по URL (same-origin: cross-origin запросы SW пропускает мимо,
 * не заходя в `classify`). Порядок ветвей важен: `/api/account/x` — это `api`,
 * а не `private-html`; `/login/magic` — `private-html`, а не просто навигация.
 *
 * `base` — префикс приложения (в проде пустая строка), нужен для dev-прокси.
 */
export function classify(url: URL, base: string): SwTarget {
  const path = stripBase(url.pathname, base);

  if (path === '/api' || path.startsWith(API_PREFIX)) return 'api';
  if (PRIVATE_HTML_PREFIXES.some((prefix) => matchesPrefix(path, prefix))) return 'private-html';
  if (path.startsWith(NEXT_STATIC_PREFIX)) return 'next-static';
  if (isAssetPath(path)) return 'asset';
  return 'other';
}
