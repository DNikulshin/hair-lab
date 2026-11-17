import { z } from 'zod';
import { bookingStatusSchema, calendarDateSchema } from '../booking/booking.contract';
import { idSchema } from '../common/ids';
import { isoDateTimeSchema } from '../common/time';

/**
 * Записи на день в админке (#242): список дня и переходы статусов
 * (`confirm`, `cancel`, `complete`, `no-show`).
 *
 * Отличия от клиентских схем `booking.contract` и почему они не переиспользуются:
 * - администратору нужен рабочий контакт клиента целиком (`clientPhone`), чтобы позвонить
 *   и подтвердить визит. В кабинете клиента телефона нет — только маска. Поэтому схема
 *   отдельная, а ПДн отдаются только по сессии сотрудника;
 * - цена отдаётся в копейках (`priceKopecks`) — админке нужны числа для расчётов, а не
 *   денежный DTO с валютой;
 * - причина отмены (`cancelReason`) отдаётся наружу: сотрудник должен видеть, кто и почему
 *   отменил визит, а не догадываться по статусу. Поле опциональное: `null` — отмены не было,
 *   отсутствие поля — ответ API старой версии (см. комментарий у поля);
 * - почта клиента (`clientEmail`), `createdAt` и `paymentDeadlineAt` наружу не отдаются:
 *   экрану админки они не нужны.
 *
 * Инварианты, которые обеспечивает API (в схеме не выражаются):
 * - список — записи одного календарного дня в часовом поясе салона (границы дня считаются
 *   по TZ, а не по UTC и не «+24 часа»), порядок — по началу приёма, затем по id;
 * - `confirm` — из `pending`, `cancel` — из `pending`/`confirmed`, `complete` и `no_show` —
 *   из `pending`/`confirmed`; финальные статусы (`cancelled`, `completed`, `no_show`)
 *   повторно не меняются — 409 `conflict`;
 * - повтор действия, которое уже выполнено, идемпотентен (200, запись не переписывается);
 * - причина салонной отмены попадает в БД с префиксом `cancelled_by_salon: ` — так она
 *   отличима от клиентской (`cancelled_by_client`) и от служебных причин оплаты;
 * - `cancelReason` — машинная строка из БД, не текст для экрана: человеческие подписи
 *   строит клиент, а неизвестное значение он показывает нейтрально («Отменена»), поэтому
 *   новые служебные коды не ломают установленные версии.
 */

/**
 * Запись дня в админке. `clientName` и `clientPhone` — персональные данные клиента:
 * в ответах они есть только у авторизованного сотрудника и никогда не попадают в логи
 * (телефон в логах — только маской).
 */
export const adminAppointmentSchema = z.object({
  id: idSchema,
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  status: bookingStatusSchema,
  /** Стоимость на момент записи (снимок цены услуги), в копейках. */
  priceKopecks: z.number().int().nonnegative(),
  durationMin: z.number().int().positive(),
  serviceName: z.string().min(1),
  masterName: z.string().min(1),
  clientName: z.string().min(1),
  clientPhone: z.string().min(1),
  /**
   * Причина отмены как она лежит в БД: `cancelled_by_client`, `cancelled_by_salon: <причина>`,
   * служебные коды оплаты (`payment_expired`, `payment_canceled`, `payment_creation_failed`).
   * `null` — запись не отменялась.
   *
   * Поле опциональное ради обратной совместимости: схема валидирует ответ API, и новый web
   * обязан принимать ответ прежней версии API, где поля ещё не было (старые клиенты живут
   * неделями из-за кэша PWA). Отсутствие поля UI трактует так же, как `null`, — «причины
   * отмены нет» — и подпись не выводит. API поле отдаёт всегда.
   */
  cancelReason: z.string().nullable().optional(),
});
export type AdminAppointment = z.infer<typeof adminAppointmentSchema>;

/** Параметры `GET /admin/appointments`: дата в часовом поясе салона. */
export const adminAppointmentsQuerySchema = z.object({
  date: calendarDateSchema,
});
export type AdminAppointmentsQuery = z.infer<typeof adminAppointmentsQuerySchema>;

/** Список записей дня: без пагинации — записей одного дня заведомо немного. */
export const adminAppointmentsResponseSchema = z.object({
  items: z.array(adminAppointmentSchema),
});
export type AdminAppointmentsResponse = z.infer<typeof adminAppointmentsResponseSchema>;

/**
 * Тело `POST /admin/appointments/:id/cancel`: причина обязательна.
 * Пустая строка (в том числе из одних пробелов) — 400: салонная отмена без причины
 * неотличима от клиентской и не объясняет клиенту, почему визит отменён.
 */
export const adminCancelRequestSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});
export type AdminCancelRequest = z.infer<typeof adminCancelRequestSchema>;

/** Ответ действия: состояние записи после перехода, чтобы админка обновила строку без запроса. */
export const adminAppointmentResponseSchema = z.object({
  booking: adminAppointmentSchema,
});
export type AdminAppointmentResponse = z.infer<typeof adminAppointmentResponseSchema>;
