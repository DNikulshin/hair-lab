import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { healthResponseSchema } from '@hair-lab/contracts';

const version = process.env.npm_package_version ?? '0.1.0';

/**
 * GET /health — проверка работоспособности. Используется деплоем и мониторингом,
 * не отдаёт никаких данных о салоне и клиентах.
 */
export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Проверка работоспособности API',
        response: { 200: healthResponseSchema },
      },
    },
    async () => ({
      status: 'ok' as const,
      version,
      checkedAt: new Date().toISOString(),
    }),
  );
};
