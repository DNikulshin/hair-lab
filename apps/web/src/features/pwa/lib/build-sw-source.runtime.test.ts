import { describe, expect, it } from 'vitest';
import { buildSwSource } from './build-sw-source';
import { OFFLINE_PATH, PRECACHE_CACHE, RUNTIME_CACHE, withBase } from './sw-policy';

/**
 * Поведенческие тесты сгенерированного service worker без браузера.
 *
 * Исходник SW — шаблонная строка, поэтому структурные проверки в
 * `build-sw-source.test.ts` не доказывают, что Cache-Control соблюдается и что ошибка
 * `cache.put` не подменяет ответ. Здесь исходник вычисляется через `new Function`
 * с подставленными `self`, `caches`, `fetch`, `Response`, `Request`, `AbortController`
 * и таймерами (фейковый `setTimeout` не срабатывает никогда — тесты детерминированы).
 */

const ORIGIN = 'https://hair-lab.test';
const OFFLINE_URL = withBase(OFFLINE_PATH, '');

/** Минимальный Request: `mode: 'navigate'` настоящим `Request` не собрать. */
interface FakeRequest {
  url: string;
  method: string;
  mode: string;
}

interface SwEvent {
  request: FakeRequest;
  respondWith(promise: Promise<Response>): void;
  waitUntil(promise: Promise<unknown>): void;
}

function urlOf(request: FakeRequest | string): string {
  return typeof request === 'string' ? request : request.url;
}

/**
 * `Response` из node даёт `type === 'default'`, в браузере same-origin fetch — `basic`.
 * Поэтому тип подставляем явно, иначе предикат кэшируемости всегда отсекал бы ответ.
 */
function makeResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string>; type?: string } = {},
): Response {
  const response = new Response(body, { status: init.status ?? 200, headers: init.headers });
  Object.defineProperty(response, 'type', {
    value: init.type ?? 'basic',
    configurable: true,
    enumerable: true,
  });
  return response;
}

function navigation(path: string): FakeRequest {
  return { url: `${ORIGIN}${path}`, method: 'GET', mode: 'navigate' };
}

function get(path: string): FakeRequest {
  return { url: `${ORIGIN}${path}`, method: 'GET', mode: 'cors' };
}

class FakeCache {
  readonly entries = new Map<string, Response>();
  failPut = false;

  constructor(seed: Record<string, Response> = {}) {
    for (const [url, response] of Object.entries(seed)) this.entries.set(url, response);
  }

  async match(request: FakeRequest | string): Promise<Response | undefined> {
    return this.entries.get(urlOf(request));
  }

  async put(request: FakeRequest, response: Response): Promise<void> {
    if (this.failPut) throw new Error('cache.put: отказано (квота, Vary: *)');
    this.entries.set(urlOf(request), response);
  }

  async addAll(urls: string[]): Promise<void> {
    for (const url of urls) this.entries.set(url, makeResponse(''));
  }
}

interface HarnessOptions {
  base?: string;
  /** Ответы сети по URL; отсутствующий маршрут означает «сети нет». */
  network?: Record<string, () => Response>;
  cachedRuntime?: Record<string, Response>;
  cachedPrecache?: Record<string, Response>;
  /** `cache.put` всегда реджектится (нехватка места, `Vary: *`). */
  failPut?: boolean;
  /** `caches.open` реджектится. */
  failOpen?: boolean;
}

interface Harness {
  /** Что вернул SW через `respondWith`; `undefined` — запрос не перехвачен. */
  dispatch(request: FakeRequest): Promise<Response | undefined>;
  /** Дождаться фоновых задач (`event.waitUntil`), например обновления SWR. */
  settle(): Promise<void>;
  readonly fetchCalls: string[];
  readonly respondWithCalls: number;
  readonly runtime: FakeCache;
  readonly precache: FakeCache;
}

function createHarness(options: HarnessOptions = {}): Harness {
  const handlers = new Map<string, (event: SwEvent) => void>();
  const background: Promise<unknown>[] = [];
  const fetchCalls: string[] = [];
  let respondWithCalls = 0;

  const runtime = new FakeCache(options.cachedRuntime);
  const precache = new FakeCache(options.cachedPrecache);
  runtime.failPut = options.failPut === true;

  const caches = {
    async open(name: string): Promise<FakeCache> {
      if (options.failOpen === true) throw new Error('caches.open: отказано');
      return name === PRECACHE_CACHE ? precache : runtime;
    },
    async match(request: FakeRequest | string): Promise<Response | undefined> {
      for (const cache of [precache, runtime]) {
        const hit = await cache.match(request);
        if (hit) return hit;
      }
      return undefined;
    },
    async keys(): Promise<string[]> {
      return [PRECACHE_CACHE, RUNTIME_CACHE];
    },
    async delete(): Promise<boolean> {
      return true;
    },
  };

  const network = options.network ?? {};
  async function fetchStub(request: FakeRequest): Promise<Response> {
    fetchCalls.push(request.url);
    const route = network[request.url];
    if (!route) throw new TypeError('Failed to fetch');
    return route();
  }

  const self = {
    location: { origin: ORIGIN },
    addEventListener(type: string, handler: (event: SwEvent) => void): void {
      handlers.set(type, handler);
    },
  };

  // Таймеры не срабатывают: навигационный таймаут не должен гоняться с assertions.
  const scheduledTimers: Array<() => void> = [];

  const factory = new Function(
    'self',
    'caches',
    'fetch',
    'Response',
    'Request',
    'AbortController',
    'setTimeout',
    'clearTimeout',
    buildSwSource({ base: options.base ?? '' }),
  );
  factory(
    self,
    caches,
    fetchStub,
    Response,
    Request,
    AbortController,
    (callback: () => void) => scheduledTimers.push(callback),
    () => undefined,
  );

  return {
    get fetchCalls() {
      return fetchCalls;
    },
    get respondWithCalls() {
      return respondWithCalls;
    },
    runtime,
    precache,
    async dispatch(request: FakeRequest): Promise<Response | undefined> {
      const handler = handlers.get('fetch');
      if (!handler) throw new Error('fetch-обработчик не зарегистрирован');
      const state: { responded?: Promise<Response> } = {};
      handler({
        request,
        respondWith(promise) {
          respondWithCalls += 1;
          state.responded = promise;
        },
        waitUntil(promise) {
          background.push(promise);
        },
      });
      if (!state.responded) return undefined;
      return await state.responded;
    },
    async settle(): Promise<void> {
      await Promise.all(background.splice(0));
    },
  };
}

async function bodyOf(response: Response | undefined): Promise<string> {
  expect(response).toBeDefined();
  return (response as Response).text();
}

describe('service worker: Cache-Control соблюдается', () => {
  it('ответ с no-store не попадает в кэш и не отдаётся потом офлайн', async () => {
    const networkResponse = makeResponse('<html>book</html>', {
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store, private' },
    });
    const sw = createHarness({ network: { [`${ORIGIN}/book`]: () => networkResponse } });

    const response = await sw.dispatch(navigation('/book'));

    expect(await bodyOf(response)).toBe('<html>book</html>');
    expect(sw.runtime.entries.size).toBe(0);
    expect(sw.precache.entries.size).toBe(0);
  });

  it('ответ с private (с параметром и в другом регистре) не кэшируется', async () => {
    const sw = createHarness({
      network: {
        [`${ORIGIN}/book`]: () =>
          makeResponse('<html>private</html>', {
            headers: { 'Cache-Control': 'PRIVATE="Set-Cookie", max-age=0' },
          }),
      },
    });

    const response = await sw.dispatch(navigation('/book'));

    expect(await bodyOf(response)).toBe('<html>private</html>');
    expect(sw.runtime.entries.size).toBe(0);
  });

  it('только no-store в верхнем регистре тоже отсекается', async () => {
    const sw = createHarness({
      network: {
        [`${ORIGIN}/book`]: () => makeResponse('x', { headers: { 'Cache-Control': 'No-Store' } }),
      },
    });

    await sw.dispatch(navigation('/book'));

    expect(sw.runtime.entries.size).toBe(0);
  });

  it('обычный ответ кэшируется и переживает падение сети', async () => {
    const url = `${ORIGIN}/services`;
    const sw = createHarness({
      network: {
        [url]: () =>
          makeResponse('<html>services</html>', {
            headers: { 'Cache-Control': 'public, max-age=60' },
          }),
      },
    });

    expect(await bodyOf(await sw.dispatch(navigation('/services')))).toBe('<html>services</html>');
    expect(sw.runtime.entries.has(url)).toBe(true);

    // Сеть пропала: тот же harness, но маршрут больше не отвечает.
    const offlineSw = createHarness({
      cachedRuntime: { [url]: makeResponse('<html>services</html>') },
    });
    expect(await bodyOf(await offlineSw.dispatch(navigation('/services')))).toBe(
      '<html>services</html>',
    );
  });

  it('cache-first и SWR тоже не кладут no-store в кэш', async () => {
    const staticUrl = `${ORIGIN}/_next/static/chunks/main.js`;
    const imageUrl = `${ORIGIN}/icons/icon-192.png`;
    const noStore = { headers: { 'Cache-Control': 'no-store' } };

    const staticSw = createHarness({
      network: { [staticUrl]: () => makeResponse('console.log(1);', noStore) },
    });
    expect(await bodyOf(await staticSw.dispatch(get('/_next/static/chunks/main.js')))).toBe(
      'console.log(1);',
    );
    expect(staticSw.runtime.entries.size).toBe(0);

    const imageSw = createHarness({ network: { [imageUrl]: () => makeResponse('png', noStore) } });
    expect(await bodyOf(await imageSw.dispatch(get('/icons/icon-192.png')))).toBe('png');
    await imageSw.settle();
    expect(imageSw.runtime.entries.size).toBe(0);
  });
});

describe('service worker: ошибка записи в кэш не меняет ответ', () => {
  it('network-first отдаёт сетевой ответ, а не /offline', async () => {
    const url = `${ORIGIN}/services`;
    const sw = createHarness({
      failPut: true,
      cachedPrecache: { [OFFLINE_URL]: makeResponse('<h1>Нет подключения</h1>') },
      network: { [url]: () => makeResponse('<html>fresh</html>') },
    });

    const response = await sw.dispatch(navigation('/services'));

    expect(response?.status).toBe(200);
    expect(await bodyOf(response)).toBe('<html>fresh</html>');
    expect(sw.runtime.entries.size).toBe(0);
  });

  it('cache-first отдаёт сетевой ответ, а не отвергнутый промис', async () => {
    const sw = createHarness({
      failPut: true,
      network: {
        [`${ORIGIN}/_next/static/chunks/main.js`]: () => makeResponse('console.log(1);'),
      },
    });

    const response = await sw.dispatch(get('/_next/static/chunks/main.js'));

    expect(await bodyOf(response)).toBe('console.log(1);');
  });

  it('stale-while-revalidate отдаёт сетевой ответ при неудачном обновлении', async () => {
    const sw = createHarness({
      failPut: true,
      network: { [`${ORIGIN}/icons/icon-192.png`]: () => makeResponse('png') },
    });

    const response = await sw.dispatch(get('/icons/icon-192.png'));
    await sw.settle();

    expect(await bodyOf(response)).toBe('png');
  });

  it('падение caches.open тоже не ломает путь', async () => {
    const sw = createHarness({
      failOpen: true,
      network: { [`${ORIGIN}/services`]: () => makeResponse('<html>fresh</html>') },
    });

    expect(await bodyOf(await sw.dispatch(navigation('/services')))).toBe('<html>fresh</html>');
  });
});

describe('service worker: границы перехвата', () => {
  it('/api/** не перехватывается: respondWith не вызван', async () => {
    const sw = createHarness({
      network: { [`${ORIGIN}/api/services`]: () => makeResponse('[]') },
    });

    const response = await sw.dispatch(navigation('/api/services'));

    expect(response).toBeUndefined();
    expect(sw.respondWithCalls).toBe(0);
    expect(sw.fetchCalls).toHaveLength(0);
  });

  it('cross-origin запрос не перехватывается даже не-GET', async () => {
    const sw = createHarness();
    const response = await sw.dispatch({
      url: 'https://fonts.example.com/inter.woff2',
      method: 'POST',
      mode: 'cors',
    });

    expect(response).toBeUndefined();
    expect(sw.respondWithCalls).toBe(0);
  });

  it('не-GET same-origin запрос не перехватывается', async () => {
    const sw = createHarness({ network: {} });
    const response = await sw.dispatch({ url: `${ORIGIN}/book`, method: 'POST', mode: 'cors' });

    expect(response).toBeUndefined();
    expect(sw.respondWithCalls).toBe(0);
  });
});

describe('service worker: офлайн-поведение навигации', () => {
  it.each(['/account', '/account/bookings/42', '/login/magic'])(
    'приватный HTML %s при падении сети отдаёт /offline и не пишет в кэш',
    async (path) => {
      const sw = createHarness({
        cachedPrecache: { [OFFLINE_URL]: makeResponse('<h1>Нет подключения</h1>') },
      });

      const response = await sw.dispatch(navigation(path));

      expect(await bodyOf(response)).toBe('<h1>Нет подключения</h1>');
      expect(sw.fetchCalls).toEqual([`${ORIGIN}${path}`]);
      expect(sw.runtime.entries.size).toBe(0);
    },
  );

  it('публичная навигация при падении сети отдаёт ранее закэшированный ответ', async () => {
    const sw = createHarness({
      cachedRuntime: { [`${ORIGIN}/services`]: makeResponse('<html>cached services</html>') },
      cachedPrecache: { [OFFLINE_URL]: makeResponse('<h1>Нет подключения</h1>') },
    });

    const response = await sw.dispatch(navigation('/services'));

    expect(await bodyOf(response)).toBe('<html>cached services</html>');
  });

  it('публичная навигация без сети и без кэша отдаёт /offline', async () => {
    const sw = createHarness({
      cachedPrecache: { [OFFLINE_URL]: makeResponse('<h1>Нет подключения</h1>') },
    });

    const response = await sw.dispatch(navigation('/services'));

    expect(await bodyOf(response)).toBe('<h1>Нет подключения</h1>');
  });
});
