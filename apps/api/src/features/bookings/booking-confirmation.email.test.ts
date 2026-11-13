import { describe, expect, it } from 'vitest';
import {
  bookingConfirmationPayloadSchema,
  formatMoment,
  formatPrice,
  renderBookingConfirmation,
} from './booking-confirmation.email';

/**
 * Письмо «запись создана»: часовой пояс салона, цена из копеек, `Reply-To`
 * в домене отправителя и экранирование HTML. Данные вымышленные.
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

describe('bookingConfirmationPayloadSchema', () => {
  it('принимает снимок записи', () => {
    expect(() => bookingConfirmationPayloadSchema.parse(payload)).not.toThrow();
  });

  it('отклоняет снимок без email и с не-ISO временем', () => {
    expect(() =>
      bookingConfirmationPayloadSchema.parse({ ...payload, clientEmail: undefined }),
    ).toThrow();
    expect(() =>
      bookingConfirmationPayloadSchema.parse({ ...payload, startsAt: '14.11.2026 10:00' }),
    ).toThrow();
    expect(() =>
      bookingConfirmationPayloadSchema.parse({ ...payload, priceKopecks: -1 }),
    ).toThrow();
  });
});

describe('formatMoment', () => {
  it('показывает время в часовом поясе салона', () => {
    const moment = formatMoment(new Date(payload.startsAt), 'Europe/Moscow');

    expect(moment).toContain('14 ноября');
    expect(moment).toContain('10:00');
  });

  it('тот же момент в UTC выглядит иначе', () => {
    const moment = formatMoment(new Date(payload.startsAt), 'UTC');

    expect(moment).toContain('07:00');
    expect(moment).not.toContain('10:00');
  });
});

describe('formatPrice', () => {
  it('переводит копейки в рубли', () => {
    expect(plain(formatPrice(350_000))).toBe('3 500 ₽');
    expect(plain(formatPrice(350_050))).toBe('3 500,50 ₽');
  });
});

describe('renderBookingConfirmation', () => {
  it('собирает письмо с датой, ценой, длительностью и подписью', () => {
    const email = renderBookingConfirmation(payload, context);

    expect(email.to).toBe('guest@example.invalid');
    expect(email.subject).toContain('10:00');
    expect(email.text).toContain(payload.clientName);
    expect(email.text).toContain(`Услуга: ${payload.serviceName}`);
    expect(email.text).toContain(`Мастер: ${payload.masterName}`);
    expect(email.text).toContain('Длительность: 60 мин');
    expect(plain(email.text)).toContain('Стоимость: 3 500 ₽');
    expect(email.text).toContain(context.fromName);
    expect(email.html).toContain('Стрижка');
    expect(email.startsAt).toEqual(new Date(payload.startsAt));
  });

  it('Reply-To — общий ящик в домене отправителя', () => {
    expect(renderBookingConfirmation(payload, context).replyTo).toBe('hello@example.invalid');

    const withoutDomain = renderBookingConfirmation(payload, { ...context, fromEmail: 'noreply' });
    expect(withoutDomain.replyTo).toBeUndefined();
  });

  it('экранирует HTML в пользовательских строках, но не в текстовой версии', () => {
    const name = '<b>Анна & Ко</b>';

    const email = renderBookingConfirmation({ ...payload, clientName: name }, context);

    expect(email.html).not.toContain('<b>');
    expect(email.html).toContain('&lt;b&gt;Анна &amp; Ко&lt;/b&gt;');
    expect(email.html).not.toContain('<script>');
    expect(email.text).toContain(name);
  });

  it('не подставляет адрес салона: его нет в конфигурации', () => {
    const email = renderBookingConfirmation(payload, context);

    expect(email.text).not.toContain('Адрес');
    expect(email.html).not.toContain('Адрес');
  });

  it('бросает на невалидном снимке', () => {
    expect(() => renderBookingConfirmation({}, context)).toThrow();
    expect(() =>
      renderBookingConfirmation({ ...payload, clientEmail: 'не-почта' }, context),
    ).toThrow();
  });
});
