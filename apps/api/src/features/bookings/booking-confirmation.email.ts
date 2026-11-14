import { z } from 'zod';
import type { EmailTemplate, RenderedEmail } from '../../shared/email';

/**
 * Письмо «запись создана»: снимок данных записи и его рендер.
 *
 * Снимок (`payload` в outbox) фиксируется в момент записи, поэтому изменение названия услуги
 * или прайса позже не переписывает уже отправленное письмо. Персональные данные (имя, email)
 * живут только в БД и в письме: в логи они не попадают.
 *
 * Адрес салона в письме не указывается: в конфигурации его нет, выдумывать данные нельзя
 * (уточнение супервизора к плану #9). Вопрос владельцу — в follow-ups.
 */

/** Тип письма в `outbox_messages.type`: без enum, чтобы новый тип не требовал миграции. */
export const BOOKING_CONFIRMATION_TYPE = 'booking_confirmation';

/**
 * Схема снимка. `startsAt`/`endsAt` — ISO 8601 в UTC: часовой пояс применяется при рендере,
 * поэтому смена `SALON_TIMEZONE` корректно влияет на текст письма.
 */
export const bookingConfirmationPayloadSchema = z.object({
  clientName: z.string().trim().min(1).max(120),
  clientEmail: z.email().max(254),
  serviceName: z.string().trim().min(1).max(200),
  masterName: z.string().trim().min(1).max(200),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  priceKopecks: z.number().int().nonnegative(),
  durationMin: z.number().int().positive(),
});
export type BookingConfirmationPayload = z.infer<typeof bookingConfirmationPayloadSchema>;

/**
 * Входные данные снимка: строка записи и её снимки цены/длительности.
 * Даты — `Date`, чтобы снимок нельзя было записать с локальным временем вместо UTC.
 */
export interface BookingConfirmationSnapshot {
  clientName: string;
  clientEmail: string;
  serviceName: string;
  masterName: string;
  startsAt: Date;
  endsAt: Date;
  priceKopecks: number;
  durationMin: number;
}

/**
 * Снимок письма-подтверждения для `outbox_messages.payload`.
 *
 * Общая точка сборки снимка: письмо ставится не только при создании записи, но и после
 * успешной оплаты (фича `payments`). Схема проверяется здесь же: в БД не должен попасть
 * снимок, который диспетчер потом отвергнет как невалидный.
 */
export function buildBookingConfirmationPayload(
  input: BookingConfirmationSnapshot,
): BookingConfirmationPayload {
  return bookingConfirmationPayloadSchema.parse({
    clientName: input.clientName,
    clientEmail: input.clientEmail,
    serviceName: input.serviceName,
    masterName: input.masterName,
    startsAt: input.startsAt.toISOString(),
    endsAt: input.endsAt.toISOString(),
    priceKopecks: input.priceKopecks,
    durationMin: input.durationMin,
  });
}

export interface BookingConfirmationContext {
  /** Часовой пояс салона (`SALON_TIMEZONE`): в нём показываем дату и время. */
  timezone: string;
  /** Имя отправителя (`SMTP_FROM_NAME`) — подпись письма. */
  fromName: string;
  /** Адрес отправителя (`SMTP_FROM_EMAIL`): из его домена строится `Reply-To`. */
  fromEmail: string;
}

/** Время в поясе салона: «суббота, 14 ноября, 10:00». */
export function formatMoment(startsAt: Date, timezone: string): string {
  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(startsAt);
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(startsAt);
  return `${date}, ${time}`;
}

/** Копейки → «3 500 ₽» (без копеек, если сумма целая). */
export function formatPrice(priceKopecks: number): string {
  const fractionDigits = priceKopecks % 100 === 0 ? 0 : 2;
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(priceKopecks / 100);
}

/** Экранирование HTML: в письмо подставляются пользовательские строки. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Ответы клиентов идут на общий ящик салона в том же домене, что и отправитель.
 * Экспортируется для письма об отмене: домен `Reply-To` считается одинаково.
 */
export function replyToOf(fromEmail: string): string | undefined {
  const at = fromEmail.lastIndexOf('@');
  if (at <= 0 || at === fromEmail.length - 1) return undefined;
  return `hello@${fromEmail.slice(at + 1)}`;
}

export function renderBookingConfirmation(
  payload: unknown,
  context: BookingConfirmationContext,
): RenderedEmail {
  const data = bookingConfirmationPayloadSchema.parse(payload);
  const startsAt = new Date(data.startsAt);
  const moment = formatMoment(startsAt, context.timezone);
  const price = formatPrice(data.priceKopecks);
  const duration = `${data.durationMin} мин`;
  const replyTo = replyToOf(context.fromEmail);

  const subject = `Запись создана — ${moment}`;

  const lines = [
    `Здравствуйте, ${data.clientName}!`,
    '',
    'Вы записаны:',
    `Услуга: ${data.serviceName}`,
    `Мастер: ${data.masterName}`,
    `Когда: ${moment}`,
    `Длительность: ${duration}`,
    `Стоимость: ${price}`,
    '',
    'Если планы изменились, ответьте на это письмо.',
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
    '<p>Вы записаны:</p>',
    `<table style="border-collapse:collapse">${rowsHtml}</table>`,
    '<p>Если планы изменились, ответьте на это письмо.</p>',
    `— <br>${escapeHtml(context.fromName)}`,
    '</body></html>',
  ].join('\n');

  return {
    to: data.clientEmail,
    subject,
    text,
    html,
    ...(replyTo === undefined ? {} : { replyTo }),
    startsAt,
  };
}

/** Шаблон для реестра: рендер с настройками салона. */
export function createBookingConfirmationTemplate(
  context: BookingConfirmationContext,
): EmailTemplate {
  return { render: (payload) => renderBookingConfirmation(payload, context) };
}
