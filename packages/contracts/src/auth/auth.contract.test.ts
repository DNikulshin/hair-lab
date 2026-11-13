import { describe, expect, it } from 'vitest';
import {
  authResponseSchema,
  clientAccountSchema,
  emailSchema,
  loginRequestSchema,
  magicLinkConsumeSchema,
  magicLinkRequestSchema,
  okResponseSchema,
  passwordSchema,
  registerRequestSchema,
} from './auth.contract';

/** Вымышленные данные: реальных клиентов, почт и паролей здесь нет. */
const clientId = '44444444-4444-4444-8444-444444444444';
const email = 'client@example.invalid';
const password = 'test-password-0001';

describe('emailSchema', () => {
  it('нормализует адрес: обрезает пробелы и приводит к нижнему регистру', () => {
    expect(emailSchema.parse('  Client@Example.INVALID ')).toBe(email);
  });

  it('отклоняет не-почту и слишком длинный адрес', () => {
    expect(() => emailSchema.parse('client.example.invalid')).toThrow();
    expect(() => emailSchema.parse('client@')).toThrow();
    expect(() => emailSchema.parse(`${'a'.repeat(250)}@example.invalid`)).toThrow();
    expect(() => emailSchema.parse(42)).toThrow();
  });

  it('в ошибке нет введённого значения (ПДн)', () => {
    const result = emailSchema.safeParse('  не-почта@ ');

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.success ? {} : result.error.issues)).not.toContain('не-почта');
  });
});

describe('passwordSchema', () => {
  it('принимает границы 10 и 128 символов включительно', () => {
    expect(passwordSchema.parse('a'.repeat(10))).toHaveLength(10);
    expect(passwordSchema.parse('a'.repeat(128))).toHaveLength(128);
  });

  it('отклоняет короткий и слишком длинный пароль', () => {
    expect(() => passwordSchema.parse('a'.repeat(9))).toThrow();
    expect(() => passwordSchema.parse('a'.repeat(129))).toThrow();
  });

  it('не обрезает пробелы: они значимые символы пароля', () => {
    const withSpaces = '  pass word  ';
    expect(passwordSchema.parse(withSpaces)).toBe(withSpaces);
  });
});

describe('registerRequestSchema и loginRequestSchema', () => {
  it('нормализуют почту и сохраняют пароль как есть', () => {
    const parsed = registerRequestSchema.parse({ email: ' Client@Example.Invalid ', password });

    expect(parsed).toEqual({ email, password });
    expect(loginRequestSchema.parse({ email, password })).toEqual({ email, password });
  });

  it('возвращают ошибку с путём поля, не подставляя значения', () => {
    const result = registerRequestSchema.safeParse({ email: 'bad', password: 'short' });

    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    expect(issues.map((issue) => issue.path.join('.'))).toEqual(['email', 'password']);
    expect(JSON.stringify(issues)).not.toContain('short');
  });
});

describe('clientAccountSchema', () => {
  const client = { id: clientId, email, emailVerifiedAt: null };

  it('принимает неподтверждённую и подтверждённую почту', () => {
    expect(clientAccountSchema.parse(client)).toEqual(client);
    expect(
      clientAccountSchema.parse({ ...client, emailVerifiedAt: '2030-03-04T09:00:00.000Z' })
        .emailVerifiedAt,
    ).toBe('2030-03-04T09:00:00.000Z');
  });

  it('требует uuid, валидную почту и ISO-время с зоной', () => {
    expect(() => clientAccountSchema.parse({ ...client, id: 'abc' })).toThrow();
    expect(() => clientAccountSchema.parse({ ...client, email: 'bad' })).toThrow();
    expect(() => clientAccountSchema.parse({ ...client, emailVerifiedAt: '04.03.2030' })).toThrow();
    expect(() => clientAccountSchema.parse({ id: clientId, email })).toThrow();
  });
});

describe('magic link request contracts', () => {
  it('normalizes request email and validates consume token shape', () => {
    expect(magicLinkRequestSchema.parse({ email: ' Client@Example.Invalid ' })).toEqual({ email });
    expect(magicLinkConsumeSchema.parse({ token: 'one-time-token' })).toEqual({
      token: 'one-time-token',
    });
  });

  it('rejects empty, overlong, and non-string tokens', () => {
    expect(() => magicLinkConsumeSchema.parse({ token: '' })).toThrow();
    expect(() => magicLinkConsumeSchema.parse({ token: 'x'.repeat(129) })).toThrow();
    expect(() => magicLinkConsumeSchema.parse({ token: 42 })).toThrow();
  });
});

describe('authResponseSchema и okResponseSchema', () => {
  it('ответ входа обёрнут в { client }', () => {
    const body = { client: { id: clientId, email, emailVerifiedAt: null } };

    expect(authResponseSchema.parse(body)).toEqual(body);
    expect(() => authResponseSchema.parse(body.client)).toThrow();
  });

  it('ok — литерал true', () => {
    expect(okResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(() => okResponseSchema.parse({ ok: false })).toThrow();
    expect(() => okResponseSchema.parse({})).toThrow();
  });
});
