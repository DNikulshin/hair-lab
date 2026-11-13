import { describe, expect, it } from 'vitest';
import { createOriginAllowList, isOriginAllowed, normalizeOrigin } from './csrf';

const allowList = createOriginAllowList([
  'https://salon.example.invalid/path',
  ' http://localhost:3000 ',
]);

describe('Origin CSRF allowlist', () => {
  it('normalizes allowed origins and ignores paths', () => {
    expect(allowList).toEqual(['https://salon.example.invalid', 'http://localhost:3000']);
    expect(normalizeOrigin('not an origin')).toBeNull();
    expect(
      isOriginAllowed({ method: 'POST', origin: 'https://salon.example.invalid' }, allowList),
    ).toBe(true);
    expect(
      isOriginAllowed({ method: 'POST', origin: 'https://evil.example.invalid' }, allowList),
    ).toBe(false);
  });

  it('uses Referer when Origin is absent and rejects malformed or null origins', () => {
    expect(
      isOriginAllowed({ method: 'POST', referer: 'http://localhost:3000/login' }, allowList),
    ).toBe(true);
    expect(
      isOriginAllowed({ method: 'POST', referer: 'https://evil.example.invalid/path' }, allowList),
    ).toBe(false);
    expect(isOriginAllowed({ method: 'POST', origin: 'null' }, allowList)).toBe(false);
    expect(isOriginAllowed({ method: 'POST' }, allowList)).toBe(true);
  });

  it('does not apply origin checks to safe methods', () => {
    expect(
      isOriginAllowed({ method: 'GET', origin: 'https://evil.example.invalid' }, allowList),
    ).toBe(true);
    expect(isOriginAllowed({ method: 'OPTIONS', origin: 'null' }, allowList)).toBe(true);
  });
});
