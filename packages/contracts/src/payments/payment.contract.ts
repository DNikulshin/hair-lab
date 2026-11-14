import { z } from 'zod';
import { bookingStatusSchema } from '../booking/booking.contract';

/**
 * Оплата записи через ЮKassa (issue #8).
 *
 * Инварианты, которые обеспечивает API (в схеме не выражаются):
 * - сумма платежа не приходит от клиента: её считает сервер по снимку цены услуги;
 * - `status` — статус платежа, `appointmentStatus` — статус самой записи; в ответе нет
 *   персональных данных клиента, поэтому статус можно отдавать по одному `id` записи;
 * - тело уведомления ЮKassa не доверяется: сервер перезапрашивает состояние платежа
 *   у провайдера и сверяет сумму, а IP отправителя проверяется по allowlist.
 */

/**
 * Статус платежа: `pending` — ждём оплату (холд слота), `succeeded` — деньги получены,
 * `canceled` — платёж отменён (клиентом, провайдером или по истечении холда),
 * `refunded` — деньги возвращены (оплата пришла после истечения холда).
 */
export const paymentStatusSchema = z.enum(['pending', 'succeeded', 'canceled', 'refunded']);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

/**
 * Ответ `GET /bookings/:id/payment`. Только два статуса и никаких полей клиента:
 * страница статуса оплаты (PR2) не требует авторизации, потому что в ответе нет ПДн.
 * `pending` у записи при `off`-режиме означает «оплата не подключена».
 */
export const paymentStatusResponseSchema = z.object({
  status: paymentStatusSchema,
  appointmentStatus: bookingStatusSchema,
});
export type PaymentStatusResponse = z.infer<typeof paymentStatusResponseSchema>;

/**
 * Тело HTTP-уведомления ЮKassa (`POST /payments/webhooks/yookassa`).
 *
 * Схема намеренно `loose`: провайдер добавляет поля (`event`, `object.paid`, `object.created_at`
 * и т. п.), и новые поля не должны превращать уведомление в 400 — статус всё равно
 * перезапрашивается у ЮKassa. Значения `event`/`status` не ограничены enum: неизвестное
 * событие — не ошибка разбора, а повод его проигнорировать.
 */
export const yookassaWebhookSchema = z
  .object({
    type: z.literal('notification'),
    event: z.string().min(1),
    object: z
      .object({
        id: z.string().min(1),
        status: z.string().min(1),
        amount: z
          .object({
            value: z.string().min(1),
            currency: z.string().min(1),
          })
          .loose()
          .optional(),
      })
      .loose(),
  })
  .loose();
export type YookassaWebhook = z.infer<typeof yookassaWebhookSchema>;

// `bookingPaymentSchema` объявлена рядом с `bookingSchema` (`booking/booking.contract.ts`):
// `paymentStatusResponseSchema` уже импортирует `bookingStatusSchema` оттуда, и определение
// схемы в этом файле создало бы циклический импорт модулей. Публичный API пакета тот же.
export { bookingPaymentSchema, type BookingPayment } from '../booking/booking.contract';
