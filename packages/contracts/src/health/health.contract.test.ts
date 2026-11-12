import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health.contract';

describe('healthResponseSchema', () => {
  it('принимает корректный ответ', () => {
    const parsed = healthResponseSchema.parse({
      status: 'ok',
      version: '0.1.0',
      checkedAt: new Date().toISOString(),
    });
    expect(parsed.status).toBe('ok');
  });

  it('отклоняет неизвестный статус и время без зоны', () => {
    expect(() =>
      healthResponseSchema.parse({ status: 'down', version: '0.1.0', checkedAt: '2026-01-01' }),
    ).toThrow();
  });
});
