import { describe, expect, it } from 'vitest';
import { classifyTransportError, errorDetailOf, responseCodeOf } from './transport';

/**
 * Классификация ошибок транспорта. Тексты ошибок не разбираются (в них бывают адреса
 * и тела писем), решение принимается по коду SMTP-ответа и этапу отказа (`command`).
 */
describe('classifyTransportError', () => {
  it('550 с command=RCPT TO — подтверждённый отказ получателю, suppressed', () => {
    expect(classifyTransportError({ responseCode: 550, command: 'RCPT TO' })).toEqual({
      outcome: 'suppressed',
      responseCode: 550,
      stage: 'RCPT TO',
    });
    expect(classifyTransportError({ responseCode: 551, command: 'rcpt to' })).toMatchObject({
      outcome: 'suppressed',
    });
    for (const responseCode of [552, 553, 554]) {
      expect(classifyTransportError({ responseCode, command: 'RCPT TO' })).toEqual({
        outcome: 'suppressed',
        responseCode,
        stage: 'RCPT TO',
      });
    }
  });

  it('550 с command=MAIL FROM — отказ отправителю, retry (не подавляем навсегда)', () => {
    expect(classifyTransportError({ responseCode: 550, command: 'MAIL FROM' })).toEqual({
      outcome: 'retry',
      responseCode: 550,
      stage: 'MAIL FROM',
    });
  });

  it('550 с command=DATA — политика содержимого, retry', () => {
    expect(classifyTransportError({ responseCode: 550, command: 'DATA' })).toEqual({
      outcome: 'retry',
      responseCode: 550,
      stage: 'DATA',
    });
  });

  it('550 без command — подтверждения отказа получателю нет, retry', () => {
    expect(classifyTransportError({ responseCode: 550 })).toEqual({
      outcome: 'retry',
      responseCode: 550,
    });
    expect(classifyTransportError({ responseCode: 550, command: undefined })).toEqual({
      outcome: 'retry',
      responseCode: 550,
    });
  });

  it('535 на AUTH — retry (сбой конфигурации, не адреса)', () => {
    expect(classifyTransportError({ responseCode: 535, command: 'AUTH PLAIN' })).toEqual({
      outcome: 'retry',
      responseCode: 535,
      stage: 'AUTH',
    });
    expect(classifyTransportError({ responseCode: 535, command: 'AUTH' })).toMatchObject({
      outcome: 'retry',
      responseCode: 535,
    });
    expect(classifyTransportError({ responseCode: 535 })).toEqual({
      outcome: 'retry',
      responseCode: 535,
    });
  });

  it('4xx на RCPT TO — всё равно retry: временный отказ не подавляет адрес', () => {
    expect(classifyTransportError({ responseCode: 450, command: 'RCPT TO' })).toEqual({
      outcome: 'retry',
      responseCode: 450,
      stage: 'RCPT TO',
    });
  });

  it('остальные 5xx — retry (включая 500 и 555)', () => {
    for (const responseCode of [500, 555]) {
      expect(classifyTransportError({ responseCode, command: 'RCPT TO' })).toEqual({
        outcome: 'retry',
        responseCode,
        stage: 'RCPT TO',
      });
      expect(classifyTransportError({ responseCode })).toEqual({ outcome: 'retry', responseCode });
    }
  });

  it('неизвестный command не попадает в last_error целиком — только OTHER', () => {
    expect(classifyTransportError({ responseCode: 550, command: 'STARTTLS' })).toEqual({
      outcome: 'retry',
      responseCode: 550,
      stage: 'OTHER',
    });
  });

  it('временный отказ 4xx — retry', () => {
    expect(classifyTransportError({ responseCode: 421 })).toEqual({
      outcome: 'retry',
      responseCode: 421,
    });
    expect(classifyTransportError({ responseCode: 450 })).toEqual({
      outcome: 'retry',
      responseCode: 450,
    });
  });

  it('таймаут и сетевые ошибки без кода — retry', () => {
    for (const error of [
      Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:465'), { code: 'ECONNECTION' }),
      new Error('getaddrinfo ENOTFOUND'),
      'не объект',
      undefined,
    ]) {
      expect(classifyTransportError(error)).toEqual({ outcome: 'retry' });
    }
  });

  it('нецелый код ответа не считается кодом SMTP', () => {
    expect(classifyTransportError({ responseCode: 550.5 })).toEqual({ outcome: 'retry' });
    expect(classifyTransportError({ responseCode: '550' })).toEqual({ outcome: 'retry' });
  });
});

describe('responseCodeOf', () => {
  it('достаёт код из строки ответа SMTP', () => {
    expect(responseCodeOf({ response: '250 2.0.0 Ok: queued as 1A2B3C' })).toBe(250);
    expect(responseCodeOf({ response: '250' })).toBe(250);
  });

  it('возвращает undefined, если кода нет', () => {
    expect(responseCodeOf({ response: 'Ok' })).toBeUndefined();
    expect(responseCodeOf({})).toBeUndefined();
    expect(responseCodeOf(null)).toBeUndefined();
    expect(responseCodeOf(undefined)).toBeUndefined();
  });
});

describe('errorDetailOf', () => {
  it('в last_error пишется только код ответа (и этап, если он известен)', () => {
    expect(errorDetailOf({ outcome: 'retry', responseCode: 421 })).toBe('smtp 421');
    expect(errorDetailOf({ outcome: 'retry' })).toBe('transport_error');
    expect(errorDetailOf({ outcome: 'suppressed', responseCode: 550, stage: 'RCPT TO' })).toBe(
      'smtp 550 RCPT TO',
    );
    expect(errorDetailOf({ outcome: 'retry', responseCode: 550, stage: 'MAIL FROM' })).toBe(
      'smtp 550 MAIL FROM',
    );
  });

  it('в last_error нет адресов и текстов ошибки', () => {
    const error = Object.assign(
      new Error('550 5.1.1 <guest@example.invalid>: Recipient address rejected'),
      {
        responseCode: 550,
        command: 'RCPT TO',
        response: '550 5.1.1 <guest@example.invalid>: Recipient address rejected',
      },
    );

    const detail = errorDetailOf(classifyTransportError(error));

    expect(detail).toBe('smtp 550 RCPT TO');
    expect(detail).not.toContain('example.invalid');
    expect(detail).not.toContain('rejected');
  });
});
