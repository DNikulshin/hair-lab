import type { EmailTemplate, RenderedEmail } from '../../shared/email';
import {
  bookingConfirmationPayloadSchema,
  escapeHtml,
  formatMoment,
  formatPrice,
  replyToOf,
  type BookingConfirmationContext,
  type BookingConfirmationPayload,
} from './booking-confirmation.email';

/**
 * Письмо «запись отменена»: снимок отменённой записи и его рендер.
 *
 * Событие то же, что у подтверждения — запись, услуга, мастер, время, цена, — поэтому снимок
 * (`payload` в outbox) повторяет схему подтверждения: отдельные поля не заводим, чтобы они
 * не разошлись. Снимок фиксируется в момент отмены, правка услуги или прайса позже его не меняет.
 *
 * Адрес салона в письме не указывается (в конфигурации его нет), телефон клиента в письмо
 * не попадает. Персональные данные (имя, почта) живут только в БД и в письме.
 */

/** Тип письма в `outbox_messages.type`: без enum, чтобы новый тип не требовал миграции. */
export const BOOKING_CANCELLATION_TYPE = 'booking_cancellation';

/** Снимок отмены — ровно те же поля, что у подтверждения (см. `bookingConfirmationPayloadSchema`). */
export const bookingCancellationPayloadSchema = bookingConfirmationPayloadSchema;
export type BookingCancellationPayload = BookingConfirmationPayload;

/** Настройки салона для рендера: те же, что у подтверждения. */
export type BookingCancellationContext = BookingConfirmationContext;

export function renderBookingCancellation(
  payload: unknown,
  context: BookingCancellationContext,
): RenderedEmail {
  const data = bookingCancellationPayloadSchema.parse(payload);
  const startsAt = new Date(data.startsAt);
  const moment = formatMoment(startsAt, context.timezone);
  const price = formatPrice(data.priceKopecks);
  const duration = `${data.durationMin} мин`;
  const replyTo = replyToOf(context.fromEmail);

  const subject = `Запись отменена — ${moment}`;

  const lines = [
    `Здравствуйте, ${data.clientName}!`,
    '',
    'Ваша запись отменена:',
    `Услуга: ${data.serviceName}`,
    `Мастер: ${data.masterName}`,
    `Когда: ${moment}`,
    `Длительность: ${duration}`,
    `Стоимость: ${price}`,
    '',
    'Если хотите записаться на другое время, ответьте на это письмо.',
    '',
    '—',
    context.fromName,
  ];
  const text = lines.join('\n');

  const rows: Array<[string, string]> = [
    ['Услуга', data.serviceName],
    ['Мастер', data.masterName],
    ['Когда', moment],
    ['Длительность', duration],
    ['Стоимость', price],
  ];
  const rowsHtml = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:2px 12px 2px 0;color:#6b7280">${escapeHtml(label)}</td>` +
        `<td style="padding:2px 0">${escapeHtml(value)}</td></tr>`,
    )
    .join('');

  const html = [
    '<!doctype html>',
    '<html lang="ru"><body style="font-family:Arial,sans-serif;font-size:15px;color:#111827">',
    `<p>Здравствуйте, ${escapeHtml(data.clientName)}!</p>`,
    '<p>Ваша запись отменена:</p>',
    `<table style="border-collapse:collapse">${rowsHtml}</table>`,
    '<p>Если хотите записаться на другое время, ответьте на это письмо.</p>',
    `— <br>${escapeHtml(context.fromName)}`,
    '</body></html>',
  ].join('\n');

  return {
    to: data.clientEmail,
    subject,
    text,
    html,
    ...(replyTo === undefined ? {} : { replyTo }),
    // Deadline отправки — начало отменённой записи: после него письмо уже бессмысленно.
    startsAt,
  };
}

/** Шаблон для реестра: рендер с настройками салона. */
export function createBookingCancellationTemplate(
  context: BookingCancellationContext,
): EmailTemplate {
  return { render: (payload) => renderBookingCancellation(payload, context) };
}
