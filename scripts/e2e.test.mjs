import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { apiEnv, PORTS, portIsFree, webBuildEnv } from './e2e.mjs';

/**
 * Чистые помощники стенда E2E (issue #114): окружение api/web и проверка занятости порта.
 * Сам стенд (сборки, процессы, база) проверяется прогоном `pnpm e2e` в CI.
 */
describe('e2e: окружение стенда', () => {
  test('api видит временную базу, тестовый режим оплаты и заглушку провайдера', () => {
    const env = apiEnv({
      databaseUrl: 'postgresql://u:p@127.0.0.1:55432/hair_lab_test',
      caPath: '/tmp/cert.pem',
    });

    assert.equal(env.DATABASE_URL, 'postgresql://u:p@127.0.0.1:55432/hair_lab_test');
    assert.equal(env.PAYMENTS_MODE, 'test');
    assert.match(env.YOOKASSA_API_URL ?? '', /^https:\/\/127\.0\.0\.1:\d+\/v3$/u);
    assert.equal(env.NODE_EXTRA_CA_CERTS, '/tmp/cert.pem');
    // Почта выключена: наружу из стенда ничего не уходит.
    assert.equal(env.SMTP_HOST, '');
    assert.equal(env.APP_URL, `http://127.0.0.1:${PORTS.web}`);
    assert.equal(env.CORS_ORIGINS, `http://127.0.0.1:${PORTS.web}`);
  });

  test('сборка web идёт без прокси-префиксов и на api стенда', () => {
    const env = webBuildEnv();

    assert.equal(env.NEXT_BASE_PATH, '');
    assert.equal(env.NEXT_ASSET_PREFIX, '');
    assert.equal(env.NEXT_PUBLIC_API_URL, `http://127.0.0.1:${PORTS.api}`);
  });

  test('занятый порт определяется, свободный — тоже', async () => {
    assert.equal(await portIsFree(PORTS.stub), true);

    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise((resolveListen) => server.listen(PORTS.stub, '127.0.0.1', resolveListen));
    try {
      assert.equal(await portIsFree(PORTS.stub), false);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });
});
