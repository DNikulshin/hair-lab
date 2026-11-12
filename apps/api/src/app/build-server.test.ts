import { afterAll, describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@hair-lab/contracts';
import { buildServer } from './build-server';

/**
 * Тест собранного сервера (композиция + транспорт). Живёт в слое `app`,
 * потому что проверяет связку фич, а не одну фичу.
 */
const app = await buildServer();

afterAll(async () => {
  await app.close();
});

describe('собранный сервер', () => {
  it('GET /health отвечает 200 и телом по контракту', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(() => healthResponseSchema.parse(response.json())).not.toThrow();
  });

  it('неизвестный маршрут отдаёт ошибку в общем формате', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
