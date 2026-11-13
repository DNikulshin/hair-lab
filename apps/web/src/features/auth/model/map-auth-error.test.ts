import { describe, expect, it } from 'vitest';
import { mapAuthError } from './map-auth-error';

describe('mapAuthError', () => {
  it('maps duplicate registration to neutral wording', () => {
    expect(
      mapAuthError({
        kind: 'http',
        status: 409,
        body: { error: { code: 'conflict', message: 'Конфликт' } },
      }),
    ).toContain('Проверьте данные или войдите');
  });

  it('does not expose server details or entered values', () => {
    expect(
      mapAuthError({
        kind: 'http',
        status: 401,
        body: { error: { code: 'unauthorized', message: 'example.invalid private text' } },
      }),
    ).not.toContain('example.invalid');
  });

  it('handles rate limiting and network failure', () => {
    expect(mapAuthError({ kind: 'http', status: 429, body: null })).toContain('Слишком много');
    expect(mapAuthError({ kind: 'network' })).toContain('временно недоступен');
  });
});
