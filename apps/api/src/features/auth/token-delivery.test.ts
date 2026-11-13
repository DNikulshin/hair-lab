import { describe, expect, it } from 'vitest';
import { createTokenDeliveryRegistry } from './token-delivery';

describe('token delivery registry', () => {
  it('keeps a pending token available for retries until explicitly removed', () => {
    const registry = createTokenDeliveryRegistry();
    const expiresAt = new Date('2030-01-01T00:15:00.000Z');
    registry.put('token-id', { rawToken: 'unit-test-token', expiresAt });

    expect(registry.take('token-id', new Date('2030-01-01T00:00:00.000Z'))).toEqual({
      rawToken: 'unit-test-token',
      expiresAt,
    });
    expect(registry.take('token-id', new Date('2030-01-01T00:00:00.000Z'))).toEqual({
      rawToken: 'unit-test-token',
      expiresAt,
    });
    registry.remove('token-id');
    expect(registry.take('token-id', new Date('2030-01-01T00:00:00.000Z'))).toBeUndefined();
  });

  it('prunes expired tokens and never returns them', () => {
    const registry = createTokenDeliveryRegistry();
    registry.put('expired', {
      rawToken: 'expired-unit-test-token',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    registry.put('valid', {
      rawToken: 'valid-unit-test-token',
      expiresAt: new Date('2030-01-01T00:15:00.000Z'),
    });

    expect(registry.prune(new Date('2030-01-01T00:00:00.000Z'))).toBe(1);
    expect(registry.take('expired', new Date('2029-12-31T23:59:00.000Z'))).toBeUndefined();
    expect(registry.take('valid', new Date('2030-01-01T00:00:00.000Z'))).toBeDefined();
  });

  it('lets the dispatcher classify a just-expired outbox message as expired', () => {
    const registry = createTokenDeliveryRegistry();
    const expiresAt = new Date('2030-01-01T00:00:00.000Z');
    registry.put('token-id', { rawToken: 'unit-test-token', expiresAt });

    expect(registry.take('token-id', expiresAt)).toEqual({
      rawToken: 'unit-test-token',
      expiresAt,
    });
    expect(registry.take('token-id', expiresAt)).toBeUndefined();
  });

  it('removes a token when a newer request supersedes it', () => {
    const registry = createTokenDeliveryRegistry();
    const delivery = {
      rawToken: 'unit-test-token',
      expiresAt: new Date('2030-01-01T00:15:00.000Z'),
    };
    registry.put('token-id', delivery);
    registry.remove('token-id');

    expect(registry.take('token-id', new Date('2030-01-01T00:00:00.000Z'))).toBeUndefined();
  });
});
