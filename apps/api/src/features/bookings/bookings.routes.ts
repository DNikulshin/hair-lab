import {
  apiErrorSchema,
  bookingResponseSchema,
  createBookingSchema,
  slotsQuerySchema,
  slotsResponseSchema,
} from '@hair-lab/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { buildError } from '../../shared/http/error-handler';
import { createBooking, SlotUnavailableError } from './bookings.service';
import { listSlots } from './slots.service';

/**
 * Онлайн-запись: свободные слоты и создание записи.
 *
 * Тело `POST /bookings` содержит телефон клиента, но в лог не попадает: стандартный
 * request-логгер Fastify (pino) пишет только метод, URL и адрес, тело не сериализует.
 * В ответе телефона и почты тоже нет (ПДн) — см. `bookingSchema` в контрактах.
 */
export const bookingRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/slots',
    {
      schema: {
        tags: ['bookings'],
        summary: 'Свободные слоты услуги на дату в часовом поясе салона',
        querystring: slotsQuerySchema,
        response: { 200: slotsResponseSchema },
      },
    },
    async (request) => listSlots(app.db, request.query),
  );

  app.post(
    '/bookings',
    {
      schema: {
        tags: ['bookings'],
        summary: 'Создание записи на услугу (идемпотентно по idempotencyKey)',
        body: createBookingSchema,
        response: {
          200: bookingResponseSchema,
          201: bookingResponseSchema,
          409: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { status, booking } = await createBooking(app.db, request.body);
        return reply.status(status).send({ booking });
      } catch (error) {
        // `slot_unavailable` не выводится из статуса 409, поэтому тело собираем явно.
        if (error instanceof SlotUnavailableError) {
          return reply.status(409).send(buildError('slot_unavailable', request.id));
        }
        throw error;
      }
    },
  );
};
