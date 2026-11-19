import {
  apiErrorSchema,
  bookingResponseSchema,
  createBookingSchema,
  maskPhone,
  slotsQuerySchema,
  slotsResponseSchema,
} from '@hair-lab/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { buildError } from '../../shared/http/error-handler';
import { BookingLimitError, createBookingsIpRateLimit } from './booking-limits';
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
 *
 * Анти-абьюз (issue #106): на создание записи два лимита — per-route по IP
 * (`config.rateLimit`, 10 за 10 минут) и по телефону внутри сервиса. Оба отвечают
 * `429 rate_limited`: кода в контракте ошибок не добавляли, старые клиенты видят тот же
 * формат `{ error: { code, message, requestId } }`. Телефон в ответ и логи не попадает
 * (только маска).
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
      // IP-лимит живёт в `@fastify/rate-limit`: повтор по `idempotencyKey` пакет
      // пропускает через `allowList` без инкремента счётчика (см. `booking-limits.ts`).
      config: { rateLimit: createBookingsIpRateLimit(app.db) },
      schema: {
        tags: ['bookings'],
        summary: 'Создание записи на услугу (идемпотентно по idempotencyKey)',
        body: createBookingSchema,
        response: {
          200: bookingResponseSchema,
          201: bookingResponseSchema,
          409: apiErrorSchema,
          // Лимит по IP или по телефону исчерпан: запись (и холд) не создаются.
          429: apiErrorSchema,
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
        // Лимит телефона (#106): код `rate_limited` уже есть в контракте — новых полей нет.
        // В лог — причина и маска номера: сырой телефон не пишем ни в теле, ни в логах.
        if (error instanceof BookingLimitError) {
          request.log.warn(
            {
              requestId: request.id,
              reason: error.reason,
              clientPhoneMasked: maskPhone(request.body.clientPhone),
            },
            'запись отклонена: лимит телефона',
          );
          return reply.status(429).send(buildError('rate_limited', request.id));
        }
        throw error;
      }
    },
  );
};
