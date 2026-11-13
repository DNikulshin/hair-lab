import { describe, expect, it } from 'vitest';
import {
  ARGON2_OPTIONS,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyDummyPassword,
  verifyPassword,
} from './password';

describe('password', () => {
  it('hashes and verifies using the configured argon2id parameters', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(hash, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(hash, 'wrong password')).toBe(false);
    expect(ARGON2_OPTIONS).toMatchObject({ memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  });

  it('supports dummy verification for an unknown account and rejects malformed hashes', async () => {
    await expect(verifyDummyPassword('any password')).resolves.toBeUndefined();
    expect(DUMMY_PASSWORD_HASH).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword('not-a-phc-hash', 'any password')).toBe(false);
  });
});
