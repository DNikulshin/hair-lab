import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSessionToken, hashToken, SESSION_TOKEN_BYTES } from './tokens';

describe('opaque session tokens', () => {
  it('creates 32 random bytes encoded as base64url', () => {
    const token = createSessionToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(SESSION_TOKEN_BYTES);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createSessionToken()).not.toBe(token);
  });

  it('stores a deterministic SHA-256 hex digest, not the raw token', () => {
    const token = 'opaque-example-token';
    expect(hashToken(token)).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(hashToken(token)).toHaveLength(64);
    expect(hashToken(token)).not.toBe(token);
  });
});
