import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  createIdempotencyKey,
} from './idempotency-key';

/**
 * Ключ идемпотентности: укладывается в лимиты контракта и различается у разных попыток.
 * Персональных данных в ключе нет — проверяем, что он состоит из безопасных символов.
 */
describe('createIdempotencyKey', () => {
  it('детерминирован при заданных параметрах', () => {
    expect(createIdempotencyKey(1_700_000_000_000, () => 'fixed')).toBe('guest-loyw3v28-fixed');
  });

  it('укладывается в лимиты длины контракта', () => {
    const key = createIdempotencyKey();
    expect(key.length).toBeGreaterThanOrEqual(IDEMPOTENCY_KEY_MIN_LENGTH);
    expect(key.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_MAX_LENGTH);
  });

  it('состоит из безопасных символов URL и заголовков', () => {
    expect(createIdempotencyKey()).toMatch(/^[a-z0-9-]+$/);
  });

  it('различает попытки', () => {
    const keys = new Set(Array.from({ length: 20 }, () => createIdempotencyKey()));
    expect(keys.size).toBe(20);
  });
});
