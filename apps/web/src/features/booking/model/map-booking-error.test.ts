import { describe, expect, it } from 'vitest';
import { EMPTY_BOOKING_ERRORS, firstErrorField, mapBookingError } from './map-booking-error';

/**
 * Маппинг ошибок записи: пользователь видит свои тексты, а не сообщения Zod,
 * и никогда — введённый телефон.
 */
function validationError(details: { path: string; message: string }[]) {
  return {
    error: { code: 'validation_error', message: 'Некорректные данные запроса', details },
  };
}

describe('mapBookingError', () => {
  it('на ошибки полей отдаёт подсказки рядом с полями и первую ошибку для фокуса', () => {
    const state = mapBookingError({
      kind: 'http',
      status: 400,
      body: validationError([
        { path: 'clientPhone', message: 'Telephone должен быть в формате +7XXXXXXXXXX' },
        { path: 'clientName', message: 'Too small' },
      ]),
    });

    expect(state.fieldErrors.clientName).toBeDefined();
    expect(state.fieldErrors.clientPhone).toBeDefined();
    expect(state.fieldErrors.clientEmail).toBeUndefined();
    expect(state.formError).toBeNull();
    expect(state.slotUnavailable).toBe(false);
    expect(state.apiUnavailable).toBe(false);
    expect(firstErrorField(state.fieldErrors)).toBe('clientName');
  });

  it('не повторяет введённый телефон в тексте подсказки', () => {
    const state = mapBookingError({
      kind: 'http',
      status: 400,
      body: validationError([{ path: 'clientPhone', message: 'Invalid phone +7 912 345-67-89' }]),
    });

    const message = state.fieldErrors.clientPhone ?? '';
    expect(message).not.toContain('9123456789');
    expect(message).not.toContain('345-67-89');
    expect(message).toContain('+7');
    expect(message).toContain('международный');
  });

  it('на 400 без details даёт общую ошибку формы', () => {
    const state = mapBookingError({ kind: 'http', status: 400, body: { error: {} } });
    expect(state.formError).not.toBeNull();
    expect(state.fieldErrors).toEqual({});
  });

  it('на 409 slot_unavailable просит выбрать другое время', () => {
    const state = mapBookingError({
      kind: 'http',
      status: 409,
      body: { error: { code: 'slot_unavailable', message: 'Выбранное время уже занято' } },
    });

    expect(state.slotUnavailable).toBe(true);
    expect(state.formError).not.toBeNull();
    expect(state.fieldErrors).toEqual({});
  });

  it('на 409 conflict и 404 not_found объясняет, что выбрать заново', () => {
    const conflict = mapBookingError({
      kind: 'http',
      status: 409,
      body: { error: { code: 'conflict', message: 'Конфликт состояния' } },
    });
    const notFound = mapBookingError({
      kind: 'http',
      status: 404,
      body: { error: { code: 'not_found', message: 'Не найдено' } },
    });

    expect(conflict.slotUnavailable).toBe(false);
    expect(conflict.formError).not.toBeNull();
    expect(notFound.formError).not.toBeNull();
  });

  it('на сеть и 502/503 сообщает о недоступности сервиса', () => {
    for (const failure of [
      { kind: 'network' as const },
      { kind: 'http' as const, status: 502, body: null },
      { kind: 'http' as const, status: 503, body: null },
    ]) {
      const state = mapBookingError(failure);
      expect(state.apiUnavailable).toBe(true);
      expect(state.formError).not.toBeNull();
    }
  });

  it('на прочие ответы не оставляет форму без сообщения', () => {
    for (const status of [401, 429, 500, 418]) {
      const state = mapBookingError({ kind: 'http', status, body: 'not json' });
      expect(state.formError).not.toBeNull();
      expect(state.apiUnavailable).toBe(false);
    }
  });
});

describe('firstErrorField', () => {
  it('отдаёт null, когда ошибок нет', () => {
    expect(firstErrorField(EMPTY_BOOKING_ERRORS.fieldErrors)).toBeNull();
    expect(firstErrorField({ clientEmail: 'x' })).toBe('clientEmail');
  });
});
