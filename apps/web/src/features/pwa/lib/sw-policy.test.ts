import { describe, expect, it } from 'vitest';
import { classify, PRECACHE_PATHS, withBase } from './sw-policy';

const ORIGIN = 'https://strizhlab.ru';

/** URL из пути: классификатор работает с same-origin адресами (cross-origin SW не трогает). */
function url(path: string): URL {
  return new URL(path, ORIGIN);
}

describe('classify: API', () => {
  it.each(['/api', '/api/', '/api/slots', '/api/account/bookings', '/api/auth/me'])(
    '%s → api (ответы API не кэшируются никогда)',
    (path) => {
      expect(classify(url(path), '')).toBe('api');
    },
  );

  it('похожий путь не считается API', () => {
    expect(classify(url('/api-docs'), '')).not.toBe('api');
    expect(classify(url('/apis'), '')).not.toBe('api');
  });

  it('глубже приватной страницы: /api/account/x — это api, а не private-html', () => {
    expect(classify(url('/api/account/x'), '')).toBe('api');
  });
});

describe('classify: приватный HTML', () => {
  it.each([
    '/account',
    '/account/',
    '/account/bookings/42',
    '/login',
    '/login/magic',
    '/login/magic/',
    '/register',
  ])('%s → private-html (только сеть)', (path) => {
    expect(classify(url(path), '')).toBe('private-html');
  });

  it('похожие публичные пути остаются обычными', () => {
    expect(classify(url('/registration'), '')).toBe('other');
    expect(classify(url('/accounts'), '')).toBe('other');
    expect(classify(url('/login-help'), '')).toBe('other');
  });
});

describe('classify: статика и картинки', () => {
  it.each(['/_next/static/chunks/main-abc.js', '/_next/static/css/app.css'])(
    '%s → next-static (cache-first)',
    (path) => {
      expect(classify(url(path), '')).toBe('next-static');
    },
  );

  it.each(['/icons/icon-192.png', '/images/hero.jpg', '/images/hero.JPG', '/favicon.ico'])(
    '%s → asset (stale-while-revalidate)',
    (path) => {
      expect(classify(url(path), '')).toBe('asset');
    },
  );

  it('не-статика Next и прочие файлы не кэшируются как статика', () => {
    expect(classify(url('/_next/image'), '')).toBe('other');
    expect(classify(url('/_next/data/build-id/services.json'), '')).toBe('other');
    expect(classify(url('/robots.txt'), '')).toBe('other');
  });
});

describe('classify: публичные навигации', () => {
  it.each(['/', '/services', '/masters', '/book', '/offline'])('%s → other', (path) => {
    expect(classify(url(path), '')).toBe('other');
  });
});

describe('classify: база приложения', () => {
  const base = '/absproxy/3000';

  it('база отрезается перед разбором пути', () => {
    expect(classify(url(`${base}/api/slots`), base)).toBe('api');
    expect(classify(url(`${base}/account`), base)).toBe('private-html');
    expect(classify(url(`${base}/_next/static/chunks/a.js`), base)).toBe('next-static');
    expect(classify(url(`${base}/icons/icon-512.png`), base)).toBe('asset');
    expect(classify(url(`${base}/services`), base)).toBe('other');
    expect(classify(url(base), base)).toBe('other');
  });

  it('чужая база не отрезается: путь остаётся как есть', () => {
    expect(classify(url('/px/api/slots'), '/p')).toBe('other');
    expect(classify(url('/p/api/slots'), '/px')).toBe('other');
  });

  it('без базы префиксные пути ничего не ломает', () => {
    expect(classify(url('/api/slots'), '')).toBe('api');
  });
});

describe('PRECACHE', () => {
  it('содержит офлайн-страницу и иконки, но не HTML публичных страниц', () => {
    expect(PRECACHE_PATHS).toContain('/offline');
    expect(PRECACHE_PATHS).toContain('/icons/icon-192.png');
    expect(PRECACHE_PATHS).toContain('/icons/icon-maskable-512.png');
    expect(PRECACHE_PATHS).not.toContain('/');
    expect(PRECACHE_PATHS).not.toContain('/services');
  });

  it('withBase склеивает путь с базой', () => {
    expect(withBase('/offline', '')).toBe('/offline');
    expect(withBase('/offline', '/p')).toBe('/p/offline');
  });
});
