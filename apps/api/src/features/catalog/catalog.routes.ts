import {
  mastersResponseSchema,
  servicesQuerySchema,
  servicesResponseSchema,
} from '@hair-lab/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { listMasters, listServices } from './catalog.service';

/**
 * Публичный каталог салона: `GET /services`, `GET /masters`.
 * Отдельной карточки `/services/:id` нет: витрина рендерит её из списка.
 * Ошибки валидации (400) и неизвестный маршрут (404) отдаёт общий error-handler.
 */
export const catalogRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/services',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Публичный список услуг',
        querystring: servicesQuerySchema,
        response: { 200: servicesResponseSchema },
      },
    },
    async (request) => listServices(app.db, request.query),
  );

  app.get(
    '/masters',
    {
      schema: {
        tags: ['catalog'],
        summary: 'Публичный список мастеров с их услугами',
        response: { 200: mastersResponseSchema },
      },
    },
    async () => listMasters(app.db),
  );
};
