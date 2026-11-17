import { Writable } from 'node:stream';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { healthResponseSchema } from '@hair-lab/contracts';
import type { Db } from '../../shared/db';
import { registerErrorHandler } from '../../shared/http/error-handler';
import { healthRoutes } from './health.routes';

/**
 * Фича health на фейковом `app.db`: реальная БД не нужна, оба исхода
 * (живая и недоступная БД) проверяются подменой одного метода клиента.
 */

/**
 * Строка подключения-канарейка: ни она, ни текст ошибки не должны утечь наружу.
 * «Пароль» — явная заглушка (`example-…`), иначе литерал красит гейт `secrets_scan`:
 * проверке утечки важна форма URL, а не правдоподобность секрета.
 */
const CANARY = 'postgresql://canary_user:example-canary-pw@db.invalid:5432/canary_db';

/** Лог пишется в массив строк: проверяем, что именно попало в него. */
function createLogSink() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });

  return { lines, text: () => lines.join(''), stream };
}

/** Фейковый клиент БД: считает вызовы `$queryRaw` и по сценарию падает или отвечает. */
function createFakeDb(outcome: 'ok' | 'fail') {
  const $queryRaw = vi.fn(() =>
    outcome === 'fail'
      ? Promise.reject(new Error(`connect refused by ${CANARY}`))
      : Promise.resolve([{ '?column?': 1 }]),
  );

  return { $queryRaw, db: { $queryRaw } as unknown as Db };
}

async function buildTestApp(db: Db, sink: ReturnType<typeof createLogSink>) {
  const app = Fastify({
    logger: { level: 'error', stream: sink.stream },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  app.decorate('db', db);
  await app.register(healthRoutes);

  return app;
}

describe('GET /health', () => {
  it('при живой БД отвечает 200 и `ok` по контракту', async () => {
    const sink = createLogSink();
    const { $queryRaw, db } = createFakeDb('ok');
    const app = await buildTestApp(db, sink);

    try {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
      expect(() => healthResponseSchema.parse(response.json())).not.toThrow();
      expect(response.json()).toMatchObject({ status: 'ok' });
      expect(response.json().version).toEqual(expect.any(String));
      expect(response.json().checkedAt).toEqual(expect.any(String));
      expect($queryRaw).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('при недоступной БД отвечает 503 и `degraded`, не раскрывая ошибку и строку подключения', async () => {
    const sink = createLogSink();
    const { db } = createFakeDb('fail');
    const app = await buildTestApp(db, sink);

    try {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(503);
      expect(() => healthResponseSchema.parse(response.json())).not.toThrow();
      expect(response.json()).toMatchObject({ status: 'degraded' });

      // Тело ответа: ни текста ошибки БД, ни строки подключения.
      expect(response.body).not.toContain('canary');
      expect(response.body).not.toContain('postgresql://');
      expect(response.body).not.toContain('connect refused');

      // Лог: константное сообщение об отказе, без объекта ошибки и её деталей.
      const log = sink.text();
      expect(log).toContain('health check: database unavailable');
      expect(log).not.toContain('canary');
      expect(log).not.toContain('postgresql://');
    } finally {
      await app.close();
    }
  });

  it('обращается к БД на каждый запрос', async () => {
    const sink = createLogSink();
    const { $queryRaw, db } = createFakeDb('ok');
    const app = await buildTestApp(db, sink);

    try {
      await app.inject({ method: 'GET', url: '/health' });
      await app.inject({ method: 'GET', url: '/health' });

      expect($queryRaw).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
