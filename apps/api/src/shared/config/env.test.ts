import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

/**
 * Разбор окружения: почта — необязательная интеграция. Пустой `SMTP_HOST` выключает модуль,
 * заполненный требует учётных данных. В тексте ошибки — только имена полей (значения — ПДн/секреты).
 */
const DATABASE_URL = 'postgresql://unit_test:unit_test@127.0.0.1:5432/unit_test';

describe('parseEnv: почта', () => {
  it('без SMTP_HOST почта выключена, API стартует', () => {
    const env = parseEnv({ DATABASE_URL });

    expect(env.emailEnabled).toBe(false);
    expect(env.SMTP_HOST).toBe('');
    expect(env.SMTP_PORT).toBe(465);
    expect(env.SMTP_SECURE).toBe(true);
    expect(env.SMTP_FROM_NAME).toBe('Стриж Lab');
    expect(env.APP_URL).toBe('http://localhost:3000');
  });

  it('заполненный SMTP_HOST без логина и пароля — ошибка с именами полей', () => {
    const host = 'smtp.example.invalid';
    let message = '';
    try {
      parseEnv({ DATABASE_URL, SMTP_HOST: host });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('SMTP_USER');
    expect(message).toContain('SMTP_PASSWORD');
    // Значения (хост, секреты) в текст ошибки не попадают.
    expect(message).not.toContain(host);
  });

  it('с логином и паролем почта включается', () => {
    const env = parseEnv({
      DATABASE_URL,
      SMTP_HOST: 'smtp.example.invalid',
      SMTP_USER: 'no-reply@example.invalid',
      SMTP_PASSWORD: 'app-password',
    });

    expect(env.emailEnabled).toBe(true);
    // Адрес отправителя по умолчанию равен логину ящика.
    expect(env.SMTP_FROM_EMAIL).toBe('no-reply@example.invalid');
  });

  it('SMTP_FROM_EMAIL переопределяет адрес отправителя', () => {
    const env = parseEnv({
      DATABASE_URL,
      SMTP_HOST: 'smtp.example.invalid',
      SMTP_USER: 'no-reply@example.invalid',
      SMTP_PASSWORD: 'app-password',
      SMTP_FROM_EMAIL: 'booking@example.invalid',
    });

    expect(env.SMTP_FROM_EMAIL).toBe('booking@example.invalid');
  });

  it('SMTP_SECURE=false читается как false, а не как «непустая строка»', () => {
    const disabled = parseEnv({ DATABASE_URL, SMTP_SECURE: 'false' });
    expect(disabled.SMTP_SECURE).toBe(false);

    expect(() => parseEnv({ DATABASE_URL, SMTP_SECURE: 'no' })).toThrow(/SMTP_SECURE/);
  });

  it('без DATABASE_URL падает с именем поля', () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL/);
  });
});

describe('parseEnv: оплата записи (ЮKassa)', () => {
  it('без PAYMENTS_MODE оплата выключена и ключи магазина не нужны', () => {
    const env = parseEnv({ DATABASE_URL });

    expect(env.PAYMENTS_MODE).toBe('off');
    expect(env.paymentsEnabled).toBe(false);
    expect(env.YOOKASSA_API_URL).toBe('https://api.yookassa.ru/v3');
    // Возврат по умолчанию — страница оплаты сайта.
    expect(env.YOOKASSA_RETURN_URL).toBe('http://localhost:3000/booking/payment');
    expect(env.PAYMENT_SWEEP_INTERVAL_MS).toBe(30_000);
  });

  it('test/live без ключей магазина — ошибка с именами полей, без значений', () => {
    for (const mode of ['test', 'live'] as const) {
      let message = '';
      try {
        parseEnv({ DATABASE_URL, PAYMENTS_MODE: mode });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('YOOKASSA_SHOP_ID');
      expect(message).toContain('YOOKASSA_SECRET_KEY');
    }
  });

  it('test с ключами включает оплату', () => {
    const env = parseEnv({
      DATABASE_URL,
      PAYMENTS_MODE: 'test',
      YOOKASSA_SHOP_ID: 'shop-id-0001',
      YOOKASSA_SECRET_KEY: 'test-secret-value',
    });

    expect(env.paymentsEnabled).toBe(true);
    expect(env.YOOKASSA_SHOP_ID).toBe('shop-id-0001');
  });

  it('неизвестный режим и нулевой интервал свипера отклоняются', () => {
    expect(() => parseEnv({ DATABASE_URL, PAYMENTS_MODE: 'sandbox' })).toThrow(/PAYMENTS_MODE/);
    expect(() => parseEnv({ DATABASE_URL, PAYMENT_SWEEP_INTERVAL_MS: '0' })).toThrow(
      /PAYMENT_SWEEP_INTERVAL_MS/,
    );
  });

  it('YOOKASSA_RETURN_URL переопределяет адрес возврата', () => {
    const env = parseEnv({
      DATABASE_URL,
      YOOKASSA_RETURN_URL: 'https://salon.example.invalid/paid',
    });

    expect(env.YOOKASSA_RETURN_URL).toBe('https://salon.example.invalid/paid');
  });
});
