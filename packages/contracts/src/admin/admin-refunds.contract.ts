import { z } from 'zod';
import {
  bookingStatusSchema,
  calendarDateSchema,
  refundClientStatusSchema,
} from '../booking/booking.contract';
import { idSchema } from '../common/ids';
import { isoDateTimeSchema } from '../common/time';

/**
 * Обзор возвратов в админке (#298): `GET /admin/refunds`.
 *
 * Два списка одной формой ответа:
 * - `attention` (по умолчанию) — возвраты, которые ещё не завершены: деньги должны вернуться
 *   (`pending`) или возврат не удался (`failed`) и требует разбора человеком;
 * - `completed` — возвраты, которые уже зафиксированы (`succeeded`).
 *
 * Отличия от клиентских схем `booking.contract` и почему они не переиспользуются:
 * - администратору нужен рабочий контакт клиента целиком (`clientPhone`), чтобы позвонить
 *   по поводу возврата. В кабинете клиента телефона нет — только маска (то же основание,
 *   что у `adminAppointmentsQuerySchema`, #242);
 * - сумма возврата — в копейках (`amountKopecks`): админке нужны числа, а не денежный DTO;
 * - контекст записи (`appointment`) вложен в строку: по возврату нужно видеть, за что были
 *   деньги (услуга, мастер, время, статус и причина отмены), без второго запроса на строку.
 *
 * Чего в ответе нет и не будет:
 * - `refundId` и `yookassaPaymentId` (id возврата и платежа провайдера) — служебные
 *   идентификаторы ЮKassa, салону они не нужны (решение владельца по #298);
 * - почты клиента (`clientEmail`), `createdAt` записи и дедлайна оплаты — экрану возвратов
 *   они не нужны, а ПДн отдаём по минимуму.
 *
 * Статус возврата — только словарь клиентских статусов `refundClientStatusSchema` (#103):
 * второй словарь не заводим, служебные коды БД и провайдера наружу не отдаются.
 *
 * Инварианты, которые обеспечивает API (в схеме не выражаются):
 * - период считается по `payments.created_at` (момент платежа), а не по дате записи;
 * - границы периода — календарные дни в часовом поясе салона: `from` — начало дня,
 *   `to` — конец дня включительно;
 * - порядок — старые первыми (`createdAt` по возрастанию, затем id), без пагинации;
 *   список ограничен сверху (50 строк) — обзор для человека, а не выгрузка.
 */

/** Какой список возвратов нужен: незавершённые (по умолчанию) или уже возвращённые. */
export const adminRefundsScopeSchema = z.enum(['attention', 'completed']);
export type AdminRefundsScope = z.infer<typeof adminRefundsScopeSchema>;

/**
 * Параметры `GET /admin/refunds`.
 *
 * `scope` по умолчанию `attention`: экран открывается на том, что требует действий.
 * `from`/`to` необязательны (весь период) и считаются в часовом поясе салона;
 * `from` позже `to` — ошибка запроса (400), а не пустой список: пустой список читался бы
 * как «возвратов нет», хотя фильтр противоречив.
 */
export const adminRefundsQuerySchema = z
  .object({
    scope: adminRefundsScopeSchema.default('attention'),
    from: calendarDateSchema.optional(),
    to: calendarDateSchema.optional(),
  })
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    message: 'Начало периода позже конца',
    path: ['from'],
  });
export type AdminRefundsQuery = z.infer<typeof adminRefundsQuerySchema>;

/**
 * Запись, за которую вернули деньги: контекст строки возврата.
 *
 * `clientName` и `clientPhone` — персональные данные клиента: в ответе они есть только
 * у авторизованного сотрудника и никогда не попадают в логи (телефон в логах — только маской).
 */
export const adminRefundAppointmentSchema = z.object({
  startsAt: isoDateTimeSchema,
  status: bookingStatusSchema,
  serviceName: z.string().min(1),
  masterName: z.string().min(1),
  clientName: z.string().min(1),
  clientPhone: z.string().min(1),
  /**
   * Причина отмены как она лежит в БД (`cancelled_by_client`, `cancelled_by_salon: <причина>`,
   * служебные коды оплаты). `null` — запись не отменялась. Подписи для экрана строит клиент,
   * поэтому новые служебные коды не ломают установленные версии.
   */
  cancelReason: z.string().nullable(),
});
export type AdminRefundAppointment = z.infer<typeof adminRefundAppointmentSchema>;

/** Строка обзора возвратов: платёж, сумма, дата платежа и контекст записи. */
export const adminRefundItemSchema = z.object({
  paymentId: idSchema,
  appointmentId: idSchema,
  /** Статус возврата в терминах клиента: `pending` — в пути, `failed` — не удался, `succeeded` — вернулись. */
  refundStatus: refundClientStatusSchema,
  /** Сумма платежа (снимок цены услуги), в копейках. */
  amountKopecks: z.number().int().nonnegative(),
  /** Момент создания платежа: по нему же считается период обзора. */
  createdAt: isoDateTimeSchema,
  appointment: adminRefundAppointmentSchema,
});
export type AdminRefundItem = z.infer<typeof adminRefundItemSchema>;

/** Список возвратов: без пагинации — строк немного (кап задаёт API). */
export const adminRefundsResponseSchema = z.object({
  items: z.array(adminRefundItemSchema),
});
export type AdminRefundsResponse = z.infer<typeof adminRefundsResponseSchema>;
