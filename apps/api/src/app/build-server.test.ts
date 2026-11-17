import { afterAll, describe, expect, it, vi } from 'vitest';
import { healthResponseSchema } from '@hair-lab/contracts';
import type { Db } from '../shared/db';
import { buildServer } from './build-server';

/**
 * Тест собранного сервера (композиция + транспорт). Живёт в слое `app`,
 * потому что проверяет связку фич, а не одну фичу.
 */

/**
 * Фейковый клиент БД: отказ приходит инъекцией, а не реальным соединением.
 * `vitest.config.ts` даёт фиктивный `DATABASE_URL`, но в сеть тест не ходит.
 */
const fakeDbMock = {
  $queryRaw: vi.fn(async () => {
    throw new Error('db unavailable (injected)');
  }),
  $disconnect: vi.fn(async () => {}),
};

/** Для сборки нужен только интерфейс `Db`; проверки смотрят на моки выше. */
const fakeDb = fakeDbMock as unknown as Db;

const app = await buildServer({ db: fakeDb });

afterAll(async () => {
  await app.close();
});

describe('собранный сервер', () => {
  it('GET /health без доступной БД отвечает 503 и `degraded` по контракту', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(() => healthResponseSchema.parse(response.json())).not.toThrow();
    expect(response.json()).toMatchObject({ status: 'degraded' });
    // Клиент инжектирован: реальный Prisma не создан, запрос дошёл до подмены.
    expect(fakeDbMock.$queryRaw).toHaveBeenCalled();
  });

  it('неизвестный маршрут отдаёт ошибку в общем формате', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
