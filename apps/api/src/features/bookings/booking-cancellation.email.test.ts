import { describe, expect, it } from 'vitest';
import {
  bookingCancellationPayloadSchema,
  createBookingCancellationTemplate,
  renderBookingCancellation,
} from './booking-cancellation.email';
import { formatMoment } from './booking-confirmation.email';

/**
 * Письмо «запись отменена»: часовой пояс салона, цена из копеек, `Reply-To` в домене
 * отправителя, экранирование HTML и отсутствие телефона. Данные вымышленные.
 */
const context = {
  timezone: 'Europe/Moscow',
  fromName: 'Стриж Lab',
  fromEmail: 'no-reply@example.invalid',
};

const payload = {
  clientName: 'Тестовая Клиентка',
  clientEmail: 'guest@example.invalid',
  serviceName: 'Стрижка',
  masterName: 'Тестовый Мастер',
  // 07:00 UTC = 10:00 MSK
  startsAt: '2026-11-14T07:00:00.000Z',
  endsAt: '2026-11-14T08:00:00.000Z',
  priceKopecks: 350_000,
  durationMin: 60,
};

/** Неразрывные пробелы Intl в тестах сравниваем как обычные. */
function plain(value: string): string {
  return value.replaceAll('\u00a0', ' ').replaceAll('\u202f', ' ');
}

describe('bookingCancellationPayloadSchema', () => {
  it('принимает тот же снимок, что и подтверждение', () => {
    expect(bookingCancellationPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('отклоняет снимок без email и с не-ISO временем', () => {
    expect(() =>
      bookingCancellationPayloadSchema.parse({ ...payload, clientEmail: undefined }),
    ).toThrow();
    expect(() =>
      bookingCancellationPayloadSchema.parse({ ...payload, startsAt: '14.11.2026 10:00' }),
    ).toThrow();
  });
});

describe('renderBookingCancellation', () => {
  it('собирает письмо об отмене с моментом записи и подписью', () => {
    const email = renderBookingCancellation(payload, context);

    expect(email.to).toBe('guest@example.invalid');
    expect(email.subject).toBe(
      `Запись отменена — ${formatMoment(new Date(payload.startsAt), 'Europe/Moscow')}`,
    );
    expect(email.subject).toContain('10:00');
    expect(email.text).toContain(payload.clientName);
    expect(email.text).toContain('Ваша запись отменена:');
    expect(email.text).toContain(`Услуга: ${payload.serviceName}`);
    expect(email.text).toContain(`Мастер: ${payload.masterName}`);
    expect(email.text).toContain('Длительность: 60 мин');
    expect(plain(email.text)).toContain('Стоимость: 3 500 ₽');
    expect(email.text).toContain(context.fromName);
    expect(email.html).toContain('Стрижка');
    // Deadline отправки — начало отменённой записи.
    expect(email.startsAt).toEqual(new Date(payload.startsAt));
  });

  it('тот же момент в UTC выглядит иначе: пояс берётся из контекста', () => {
    const utc = renderBookingCancellation(payload, { ...context, timezone: 'UTC' });

    expect(utc.subject).toContain('07:00');
    expect(utc.subject).not.toContain('10:00');
  });

  it('Reply-To — общий ящик в домене отправителя', () => {
    expect(renderBookingCancellation(payload, context).replyTo).toBe('hello@example.invalid');

    const withoutDomain = renderBookingCancellation(payload, { ...context, fromEmail: 'noreply' });
    expect(withoutDomain.replyTo).toBeUndefined();
  });

  it('экранирует HTML в пользовательских строках, но не в текстовой версии', () => {
    const name = '<b>Анна & Ко</b>';

    const email = renderBookingCancellation({ ...payload, clientName: name }, context);

    expect(email.html).not.toContain('<b>');
    expect(email.html).toContain('&lt;b&gt;Анна &amp; Ко&lt;/b&gt;');
    expect(email.text).toContain(name);
  });

  it('не содержит телефона клиента: в снимке его нет', () => {
    const email = renderBookingCancellation(payload, context);

    expect(email.text).not.toContain('+7');
    expect(email.html).not.toContain('+7');
  });

  it('бросает на невалидном снимке', () => {
    expect(() => renderBookingCancellation({}, context)).toThrow();
    expect(() =>
      renderBookingCancellation({ ...payload, clientEmail: 'не-почта' }, context),
    ).toThrow();
  });

  it('шаблон для реестра рендерит тот же текст', () => {
    const email = createBookingCancellationTemplate(context).render(payload);

    expect(email.to).toBe(payload.clientEmail);
    expect(email.subject).toContain('Запись отменена');
  });
});
