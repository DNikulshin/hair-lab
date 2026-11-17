import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { healthResponseSchema } from '@hair-lab/contracts';

const version = process.env.npm_package_version ?? '0.1.0';

/**
 * GET /health — проверка работоспособности. Используется деплоем и мониторингом,
 * не отдаёт никаких данных о салоне и клиентах.
 *
 * Каждый вызов делает `SELECT 1`: контейнер при мёртвой БД не должен считаться живым.
 * Ответ 503 уходит прямым `reply`, а не исключением: иначе тело ошибки подменил бы
 * общий обработчик (`internal_error`), а клиенту нужен `degraded` по контракту.
 */
export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Проверка работоспособности API',
        response: { 200: healthResponseSchema, 503: healthResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        await app.db.$queryRaw`SELECT 1`;
      } catch {
        // Константное сообщение без объекта ошибки: текст отказа БД и строка подключения
        // (в них бывают хост и логин) в лог не попадают.
        request.log.error('health check: database unavailable');
        return reply.code(503).send({
          status: 'degraded' as const,
          version,
          checkedAt: new Date().toISOString(),
        });
      }

      return { status: 'ok' as const, version, checkedAt: new Date().toISOString() };
    },
  );
};
