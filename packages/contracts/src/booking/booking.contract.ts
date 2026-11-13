import { z } from 'zod';
import { idempotencyKeySchema, idSchema } from '../common/ids';
import { moneySchema } from '../common/money';
import { phoneSchema } from '../common/phone';
import { isoDateTimeSchema } from '../common/time';

/**
 * Онлайн-запись: свободные слоты (`GET /slots`) и создание записи (`POST /bookings`).
 *
 * Инварианты, которые обеспечивает API (в схеме не выражаются):
 * - `GET /slots` отдаёт только свободные слоты: в рабочие часы мастера, без пересечения
 *   с исключениями расписания и активными записями, не раньше текущего момента с буфером;
 * - повтор `POST /bookings` с тем же `idempotencyKey` возвращает уже созданную запись:
 *   сравниваются только мастер, услуга и начало записи (`startsAt`), поэтому повтор
 *   с исправленными контактами клиента считается тем же запросом;
 * - `clientPhone` и `clientEmail` в ответах не возвращаются: это персональные данные клиента;
 *   для экрана успеха отдаётся только маска номера (`clientPhoneMasked`).
 */

/** Календарная дата в часовом поясе салона (`YYYY-MM-DD`), не момент времени. */
export const calendarDateSchema = z.iso.date();
export type CalendarDate = z.infer<typeof calendarDateSchema>;

/**
 * Параметры `GET /slots`: услуга, необязательный мастер и дата в TZ салона.
 * Без `masterId` отдаются слоты всех активных мастеров, оказывающих услугу.
 */
export const slotsQuerySchema = z.object({
  serviceId: idSchema,
  masterId: idSchema.optional(),
  date: calendarDateSchema,
});
export type SlotsQuery = z.infer<typeof slotsQuerySchema>;

/** Свободный слот: начало и конец приёма в ISO 8601 с зоной (в БД — UTC). */
export const slotSchema = z.object({
  masterId: idSchema,
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
});
export type Slot = z.infer<typeof slotSchema>;

export const slotsResponseSchema = z.object({
  items: z.array(slotSchema),
});
export type SlotsResponse = z.infer<typeof slotsResponseSchema>;

/** Статус записи: `pending` — создана и ждёт подтверждения салона. */
export const bookingStatusSchema = z.enum([
  'pending',
  'confirmed',
  'cancelled',
  'completed',
  'no_show',
]);
export type BookingStatus = z.infer<typeof bookingStatusSchema>;

/**
 * Тело `POST /bookings`. `idempotencyKey` передаётся в теле, а не заголовком:
 * web и будущий mobile и так шлют JSON, а поле проще для Swagger и отладки.
 *
 * `clientPhone` остаётся строкой, но валидируется парсером телефона и приводится к E.164
 * (`+<цифры>`) ещё на границе запроса. Форма поля для клиентов не меняется. Российская
 * запись — основная, международный номер с `+` тоже принимается (обратная совместимость
 * и гость из другой страны); 400 получает только не-телефон.
 */
export const createBookingSchema = z.object({
  masterId: idSchema,
  serviceId: idSchema,
  startsAt: isoDateTimeSchema,
  clientName: z.string().trim().min(1).max(120),
  clientPhone: phoneSchema,
  clientEmail: z.email().max(254).optional(),
  idempotencyKey: idempotencyKeySchema,
});
export type CreateBooking = z.infer<typeof createBookingSchema>;

/**
 * Созданная запись. Цена и длительность — снимки условий услуги на момент записи.
 * Контактов клиента здесь нет: наружу они не отдаются. `clientPhoneMasked` — аддитивное
 * поле для экрана успеха (маску считает сервер); старые клиенты его игнорируют.
 */
export const bookingSchema = z.object({
  id: idSchema,
  masterId: idSchema,
  serviceId: idSchema,
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  status: bookingStatusSchema,
  price: moneySchema,
  durationMin: z.number().int().positive(),
  clientName: z.string().min(1),
  clientPhoneMasked: z.string().min(1).optional(),
});
export type Booking = z.infer<typeof bookingSchema>;

export const bookingResponseSchema = z.object({
  booking: bookingSchema,
});
export type BookingResponse = z.infer<typeof bookingResponseSchema>;
