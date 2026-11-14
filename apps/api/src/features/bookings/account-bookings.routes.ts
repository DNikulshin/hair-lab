import {
  accountBookingResponseSchema,
  accountBookingsQuerySchema,
  accountBookingsResponseSchema,
  apiErrorSchema,
  idSchema,
} from '@hair-lab/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth } from '../../shared/auth';
import { buildError } from '../../shared/http/error-handler';
import { cancelAccountBooking, listAccountBookings } from './account-bookings.service';

/**
 * Кабинет клиента: мои записи и отмена.
 *
 * Оба маршрута защищены `requireAuth` (без сессии — 401 `unauthorized`) и работают только
 * с записями текущего клиента: `clientId` берётся из сессии, а не из запроса, поэтому
 * указать чужой аккаунт нельзя. Ответы не содержат контактов клиента целиком — только имя
 * и маску телефона; почта не отдаётся.
 *
 * Правило отмены (срок, статус) клиент не дублирует: он читает `cancellable` из списка
 * и решает только, показывать ли кнопку.
 *
 * `DELETE` без тела: отмена — действие над записью, а не редактирование её полей,
 * а причину отмены ставит сервер.
 */
export const accountBookingsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/account/bookings',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['account'],
        summary: 'Мои записи: предстоящие или прошлые (курсорная пагинация)',
        querystring: accountBookingsQuerySchema,
        response: { 200: accountBookingsResponseSchema, 401: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const client = request.authClient;
      if (client === null) return reply.status(401).send(buildError('unauthorized', request.id));
      return listAccountBookings(app.db, client.id, request.query);
    },
  );

  app.delete(
    '/account/bookings/:id',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['account'],
        summary: 'Отмена своей записи (не позже чем за 2 часа до начала)',
        params: z.object({ id: idSchema }),
        response: {
          200: accountBookingResponseSchema,
          401: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const client = request.authClient;
      if (client === null) return reply.status(401).send(buildError('unauthorized', request.id));
      const booking = await cancelAccountBooking(app.db, client.id, request.params.id);
      return { booking };
    },
  );
};
