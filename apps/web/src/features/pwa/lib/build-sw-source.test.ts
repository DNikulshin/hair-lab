import { describe, expect, it } from 'vitest';
import { buildSwSource } from './build-sw-source';
import {
  PRECACHE_CACHE,
  PRECACHE_PATHS,
  PRIVATE_HTML_PREFIXES,
  RUNTIME_CACHE,
  SW_CACHE_VERSION,
} from './sw-policy';

const source = buildSwSource({ base: '' });

/** Фрагмент исходника между маркерами: проверяем конкретную ветку, а не файл целиком. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe('buildSwSource: константы и precache', () => {
  it('подставляет версию и имена кэшей из политики', () => {
    expect(source).toContain(`const SW_CACHE_VERSION = ${JSON.stringify(SW_CACHE_VERSION)};`);
    expect(source).toContain(`const PRECACHE_CACHE = ${JSON.stringify(PRECACHE_CACHE)};`);
    expect(source).toContain(`const RUNTIME_CACHE = ${JSON.stringify(RUNTIME_CACHE)};`);
  });

  it('precache — офлайн-страница и иконки, без HTML публичных страниц', () => {
    expect(source).toContain(`const PRECACHE_URLS = ${JSON.stringify([...PRECACHE_PATHS])};`);
    expect(source).toContain('"/offline"');
    expect(source).toContain('"/icons/icon-maskable-512.png"');
    expect(source).not.toContain('"/services"');
  });

  it('с базой precache и офлайн-страница уходят под префикс', () => {
    const withBase = buildSwSource({ base: '/absproxy/3000' });

    expect(withBase).toContain('const BASE = "/absproxy/3000";');
    expect(withBase).toContain('"/absproxy/3000/offline"');
    expect(withBase).toContain('"/absproxy/3000/icons/icon-192.png"');
    expect(withBase).toContain('const OFFLINE_URL = "/absproxy/3000/offline";');
  });

  it('приватные разделы берутся из политики', () => {
    expect(source).toContain(
      `const PRIVATE_HTML_PREFIXES = ${JSON.stringify([...PRIVATE_HTML_PREFIXES])};`,
    );
  });
});

describe('buildSwSource: ветки обработки запросов', () => {
  it('API — passthrough: ни respondWith, ни cache.put', () => {
    const apiBranch = between(source, "if (kind === 'api')", "if (request.mode === 'navigate')");

    expect(apiBranch).toContain('return');
    expect(apiBranch).not.toContain('cache.put');
    expect(apiBranch).not.toContain('respondWith');
  });

  it('приватный HTML — только сеть, кэш не читаем и не пишем', () => {
    const fetchHandlerBranch = between(source, "if (kind === 'private-html')", '} else {');
    expect(fetchHandlerBranch).toContain('networkOnly');

    const networkOnlyBody = between(source, 'function networkOnly', 'function networkFirst');
    expect(networkOnlyBody).toContain('fetch(request)');
    expect(networkOnlyBody).not.toContain('cache.put');
    expect(networkOnlyBody).not.toContain('caches.match');
  });

  it('публичная навигация — network-first, статика — cache-first, картинки — SWR', () => {
    expect(source).toContain('event.respondWith(networkFirst(request));');
    expect(source).toContain('event.respondWith(cacheFirst(request));');
    expect(source).toContain('event.respondWith(staleWhileRevalidate(event, request));');
    expect(source).toContain('const NAV_TIMEOUT_MS = 4000;');
    expect(source).toContain('AbortController');
  });

  it('cross-origin и не-GET запросы SW не перехватывает', () => {
    expect(source).toContain("if (request.method !== 'GET') return;");
    expect(source).toContain('if (url.origin !== self.location.origin) return;');
  });

  it('cross-origin проверяется раньше метода', () => {
    const fetchHandler = between(source, "addEventListener('fetch'", '\n});\n');
    const originCheck = fetchHandler.indexOf('if (url.origin !== self.location.origin) return;');
    const methodCheck = fetchHandler.indexOf("if (request.method !== 'GET') return;");

    expect(originCheck).toBeGreaterThanOrEqual(0);
    expect(methodCheck).toBeGreaterThan(originCheck);
  });
});

describe('buildSwSource: запись в Cache API', () => {
  it('есть предикат isCacheableResponse: ok, type basic, private/no-store в Cache-Control', () => {
    const predicate = between(source, 'function isCacheableResponse', 'function putInCache');

    expect(predicate).toContain('response.ok');
    expect(predicate).toContain("response.type !== 'basic'");
    expect(predicate).toContain("'Cache-Control'");
    expect(predicate).toContain("split(',')");
    expect(predicate).toContain('toLowerCase()');
    expect(predicate).toContain("name === 'private'");
    expect(predicate).toContain("name === 'no-store'");
    // Директива с параметром: `private="Set-Cookie"`.
    expect(predicate).toContain("split('=')[0].trim()");
  });

  it('каждая стратегия проверяет предикат до записи в кэш', () => {
    const branches: ReadonlyArray<readonly [string, string]> = [
      ['function networkFirst', 'function cacheFirst'],
      ['function cacheFirst', 'function staleWhileRevalidate'],
      ['function staleWhileRevalidate', "addEventListener('install'"],
    ];

    for (const [start, end] of branches) {
      const body = between(source, start, end);
      const cacheableCheck = body.indexOf('isCacheableResponse(response)');
      const write = body.indexOf('putInCache(');

      expect(cacheableCheck).toBeGreaterThanOrEqual(0);
      expect(write).toBeGreaterThan(cacheableCheck);
    }
  });

  it('единственный cache.put лежит в putInCache и его ошибка проглатывается', () => {
    // `cache.put(` — вызовы, а не упоминания в комментариях.
    const occurrences = source.split('cache.put(').length - 1;
    expect(occurrences).toBe(1);

    const write = between(source, 'function putInCache', 'function networkOnly');
    expect(write).toContain('cache.put(request, copy)');
    expect(write).toContain('.catch(function () {');
    expect(write).toContain('return Promise.resolve();');
  });
});

describe('buildSwSource: жизненный цикл', () => {
  it('install кладёт precache в отдельный кэш', () => {
    const install = between(source, "addEventListener('install'", "addEventListener('activate'");
    expect(install).toContain('caches.open(PRECACHE_CACHE)');
    expect(install).toContain('cache.addAll(PRECACHE_URLS)');
  });

  it('activate удаляет свои кэши прошлых версий, чужие не трогает', () => {
    const activate = between(source, "addEventListener('activate'", "addEventListener('fetch'");
    expect(activate).toContain('caches.keys()');
    expect(activate).toContain('key.indexOf(CACHE_PREFIX) === 0');
    expect(activate).toContain('CACHE_NAMES.indexOf(key) === -1');
    expect(activate).toContain('caches.delete(key)');
  });

  it('без skipWaiting и clients.claim: обновление само на следующей навигации', () => {
    // Слова встречаются в комментарии-пояснении, поэтому проверяем именно вызовы.
    expect(source).not.toContain('self.skipWaiting(');
    expect(source).not.toContain('clients.claim(');
  });
});

describe('buildSwSource: исходник', () => {
  it('синтаксически валиден как тело функции', () => {
    expect(() => new Function(source)).not.toThrow();
  });

  it('при разных базах остаётся валидным', () => {
    expect(() => new Function(buildSwSource({ base: '/p' }))).not.toThrow();
  });
});
