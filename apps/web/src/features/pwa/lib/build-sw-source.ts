import {
  API_PREFIX,
  ASSET_EXTENSIONS,
  NAV_TIMEOUT_MS,
  NEXT_STATIC_PREFIX,
  OFFLINE_PATH,
  PRECACHE_CACHE,
  PRECACHE_PATHS,
  PRIVATE_HTML_PREFIXES,
  RUNTIME_CACHE,
  SW_CACHE_NAMES,
  SW_CACHE_PREFIX,
  SW_CACHE_VERSION,
  withBase,
} from './sw-policy';

/**
 * Генератор исходника service worker.
 *
 * Почему строка, а не `public/sw.js`: политика описана в `sw-policy.ts` и покрыта
 * юнит-тестами без браузера, версия и база подставляются при сборке, а заголовки
 * ответа (`Cache-Control: no-store`) контролирует Route Handler. Плата — код SW
 * живёт в шаблонной строке: его правки проверяются тестами `build-sw-source.test.ts`.
 *
 * Генерируемый код — обычный ES2020 без шаблонных строк и импортов: SW не проходит
 * через сборщик Next, поэтому всё, что ему нужно, подставляется здесь значениями.
 */

export interface BuildSwSourceOptions {
  /** Нормализованный базовый путь: `''` в проде, `/absproxy/3000` за dev-прокси. */
  base: string;
}

/** Как SW ведёт себя при разных типах запросов (навигация определяется по `request.mode`). */
export function buildSwSource({ base }: BuildSwSourceOptions): string {
  const precacheUrls = PRECACHE_PATHS.map((path) => withBase(path, base));

  return `/*
 * Service worker сайта hair-lab. Файл сгенерирован: apps/web/src/features/pwa/lib/build-sw-source.ts.
 * Руками не править — исходник и константы живут в TypeScript.
 *
 * Версия кэшей: ${SW_CACHE_VERSION}. Без skipWaiting: новый SW активируется сам,
 * когда закроются вкладки со старым, и в activate удаляет кэши прошлых версий.
 */
'use strict';

const BASE = ${JSON.stringify(base)};
const SW_CACHE_VERSION = ${JSON.stringify(SW_CACHE_VERSION)};
const CACHE_PREFIX = ${JSON.stringify(`${SW_CACHE_PREFIX}-`)};
const CACHE_NAMES = ${JSON.stringify([...SW_CACHE_NAMES])};
const PRECACHE_CACHE = ${JSON.stringify(PRECACHE_CACHE)};
const RUNTIME_CACHE = ${JSON.stringify(RUNTIME_CACHE)};
const PRECACHE_URLS = ${JSON.stringify(precacheUrls)};
const OFFLINE_URL = ${JSON.stringify(withBase(OFFLINE_PATH, base))};
const PRIVATE_HTML_PREFIXES = ${JSON.stringify([...PRIVATE_HTML_PREFIXES])};
const API_PREFIX = ${JSON.stringify(API_PREFIX)};
const NEXT_STATIC_PREFIX = ${JSON.stringify(NEXT_STATIC_PREFIX)};
const ASSET_EXTENSIONS = ${JSON.stringify([...ASSET_EXTENSIONS])};
const NAV_TIMEOUT_MS = ${NAV_TIMEOUT_MS};

/** Префикс базы: в проде BASE пустой, за dev-прокси все пути живут под префиксом. */
function stripBase(pathname) {
  if (!BASE) return pathname;
  if (pathname === BASE) return '/';
  if (pathname.indexOf(BASE + '/') === 0) return pathname.slice(BASE.length);
  return pathname;
}

/** Повторяет sw-policy.classify: api | private-html | next-static | asset | other. */
function classifyKind(pathname) {
  const path = stripBase(pathname);
  if (path === '/api' || path.indexOf(API_PREFIX) === 0) return 'api';
  for (const prefix of PRIVATE_HTML_PREFIXES) {
    if (path === prefix || path.indexOf(prefix + '/') === 0) return 'private-html';
  }
  if (path.indexOf(NEXT_STATIC_PREFIX) === 0) return 'next-static';
  const dot = path.lastIndexOf('.');
  if (dot !== -1 && ASSET_EXTENSIONS.indexOf(path.slice(dot + 1).toLowerCase()) !== -1) {
    return 'asset';
  }
  return 'other';
}

/** Офлайн-страница из precache; если её нет (первый запуск сорвался) — минимальный ответ. */
function offlineResponse() {
  return caches.match(OFFLINE_URL).then(function (cached) {
    if (cached) return cached;
    return new Response('<h1>Нет подключения</h1>', {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  });
}

/**
 * Можно ли класть ответ в Cache API.
 *
 * Cache API сам не соблюдает Cache-Control: private и no-store обязан отсечь SW,
 * иначе запрещённый сервером ответ (например, /book с Cache-Control: private, no-store)
 * переживёт сеть и будет отдан офлайн. Заголовки разбираем по запятым, без учёта
 * регистра и с отбрасыванием параметра директивы (private="Set-Cookie").
 * Заодно отсекаем не-2xx и opaque-ответы (type !== 'basic').
 */
function isCacheableResponse(response) {
  if (!response || !response.ok || response.type !== 'basic') return false;
  const headers = response.headers;
  const raw = headers && headers.get ? headers.get('Cache-Control') : null;
  if (!raw) return true;
  const directives = String(raw).toLowerCase().split(',');
  for (let i = 0; i < directives.length; i += 1) {
    const name = directives[i].split('=')[0].trim();
    if (name === 'private' || name === 'no-store') return false;
  }
  return true;
}

/**
 * Запись в runtime-кэш. Изолирована от результата запроса: отказ Cache API
 * (квота, Vary: *, битый ответ) не должен подменять успешный сетевой ответ
 * на устаревший кэш или /offline, поэтому промис всегда резолвится.
 */
function putInCache(request, response) {
  try {
    const copy = response.clone();
    return caches
      .open(RUNTIME_CACHE)
      .then(function (cache) {
        return cache.put(request, copy);
      })
      .catch(function () {
        return undefined;
      });
  } catch {
    return Promise.resolve();
  }
}

/** Приватный HTML: только сеть. Кэш не читаем и не пишем — иначе покажем чужие данные. */
function networkOnly(request) {
  return fetch(request).catch(function () {
    return offlineResponse();
  });
}

/** Публичная навигация: сеть с таймаутом, затем runtime-кэш, затем офлайн-страница. */
function networkFirst(request) {
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, NAV_TIMEOUT_MS);

  return fetch(request, { signal: controller.signal })
    .then(function (response) {
      clearTimeout(timer);
      if (!isCacheableResponse(response)) return response;
      // Ответ отдаём независимо от исхода записи: ошибка cache.put не уводит в caches.match.
      return putInCache(request, response).then(function () {
        return response;
      });
    })
    .catch(function () {
      clearTimeout(timer);
      return caches.match(request).then(function (cached) {
        if (cached) return cached;
        return offlineResponse();
      });
    });
}

/** Хэшированная статика Next: cache-first. */
function cacheFirst(request) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;
    return fetch(request).then(function (response) {
      if (!isCacheableResponse(response)) return response;
      return putInCache(request, response).then(function () {
        return response;
      });
    });
  });
}

/** Картинки и иконки: отдаём кэш сразу, обновляем в фоне. */
function staleWhileRevalidate(event, request) {
  const update = fetch(request)
    .then(function (response) {
      if (!isCacheableResponse(response)) return response;
      return putInCache(request, response).then(function () {
        return response;
      });
    })
    .catch(function () {
      return undefined;
    });

  return caches.match(request).then(function (cached) {
    if (cached) {
      event.waitUntil(update);
      return cached;
    }
    return update.then(function (response) {
      if (response) return response;
      return new Response('', { status: 504 });
    });
  });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(PRECACHE_CACHE).then(function (cache) {
      return cache.addAll(PRECACHE_URLS);
    }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) {
            // Только свои кэши прошлых версий: чужие (другой SW на том же origin) не трогаем.
            return key.indexOf(CACHE_PREFIX) === 0 && CACHE_NAMES.indexOf(key) === -1;
          })
          .map(function (key) {
            return caches.delete(key);
          }),
      );
    }),
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  const url = new URL(request.url);

  // Cross-origin (шрифты, внешние картинки) не перехватываем вовсе — проверка первая:
  // для чужого origin ни метод, ни политика кэша роли не играют.
  if (url.origin !== self.location.origin) return;
  // Не-GET не перехватываем: POST/PATCH/DELETE в Cache API не кладут.
  if (request.method !== 'GET') return;

  const kind = classifyKind(url.pathname);

  if (kind === 'api') return;

  if (request.mode === 'navigate') {
    if (kind === 'private-html') {
      event.respondWith(networkOnly(request));
    } else {
      event.respondWith(networkFirst(request));
    }
    return;
  }

  if (kind === 'next-static') {
    event.respondWith(cacheFirst(request));
  } else if (kind === 'asset') {
    event.respondWith(staleWhileRevalidate(event, request));
  }
});
`;
}
