import {
  apiErrorSchema,
  bookingResponseSchema,
  createBookingSchema,
  slotsQuerySchema,
  slotsResponseSchema,
} from '@hair-lab/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { buildError } from '../../shared/http/error-handler';
import {
  createBooking,
  PaymentCreationFailedError,
  SlotUnavailableError,
  type CreateBookingPaymentsOptions,
} from './bookings.service';
import { listSlots } from './slots.service';

/**
 * Онлайн-запись: свободные слоты и создание записи.
 *
 * Тело `POST /bookings` содержит телефон клиента, но в лог не попадает: стандартный
 * request-логгер Fastify (pino) пишет только метод, URL и адрес, тело не сериализует.
 * В ответе телефона и почты тоже нет (ПДн) — см. `bookingSchema` в контрактах.
 *
 * Запись, созданная из-под сессии, привязывается к аккаунту (`appointments.client_id`).
 * Признак берётся из `request.authClient` (cookie), а не из тела: клиент не может записать
 * визит на чужой аккаунт. Гостевая запись остаётся без аккаунта, её поля не менялись.
 *
 * Режим оплаты — опция регистрации (`app/build-server.ts`), а не чтение окружения здесь:
 * в тестах тот же маршрут работает с поддельным шлюзом без подмены `process.env`.
 */
export interface BookingRoutesOptions {
  /** Оплата включена (`PAYMENTS_MODE != 'off'`). Не задана — поведение без оплаты. */
  payments?: CreateBookingPaymentsOptions;
}

export const bookingRoutes: FastifyPluginAsyncZod<BookingRoutesOptions> = async (app, options) => {
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
          // Платёж не удалось создать: запись отменена компенсацией, слот свободен.
          502: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { status, booking } = await createBooking(
          app.db,
          request.body,
          request.authClient?.id,
          { payments: options.payments },
        );
        return reply.status(status).send({ booking });
      } catch (error) {
        // `slot_unavailable` не выводится из статуса 409, поэтому тело собираем явно.
        if (error instanceof SlotUnavailableError) {
          return reply.status(409).send(buildError('slot_unavailable', request.id));
        }
        // Шлюз недоступен: отдельного кода в контракте ошибок нет (новый код сломал бы разбор
        // тела у уже установленных клиентов), поэтому используем существующий `internal_error`.
        if (error instanceof PaymentCreationFailedError) {
          request.log.warn({ requestId: request.id }, 'платёж не создан: запись отменена');
          return reply.status(502).send(buildError('internal_error', request.id));
        }
        throw error;
      }
    },
  );
};
