import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db';
import {
  absoluteDeadline,
  findSession,
  idleExpiresAt,
  isSessionExpired,
  revokeSession,
  shouldTouch,
  touchedExpiresAt,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
} from './session';

const now = new Date('2030-01-01T00:00:00.000Z');

describe('session expiration and touch policy', () => {
  it('sets 14-day idle and 60-day absolute deadlines', () => {
    expect(SESSION_IDLE_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000);
    expect(SESSION_ABSOLUTE_TTL_MS).toBe(60 * 24 * 60 * 60 * 1000);
    expect(idleExpiresAt(now)).toEqual(new Date(now.getTime() + SESSION_IDLE_TTL_MS));
    expect(absoluteDeadline(now)).toEqual(new Date(now.getTime() + SESSION_ABSOLUTE_TTL_MS));
  });

  it('expires on idle or absolute deadline and touches no more than hourly', () => {
    const createdAt = new Date(now.getTime() - 59 * 24 * 60 * 60 * 1000);
    expect(isSessionExpired({ createdAt, expiresAt: new Date(now.getTime() + 1) }, now)).toBe(false);
    expect(isSessionExpired({ createdAt, expiresAt: now }, now)).toBe(true);
    expect(isSessionExpired({ createdAt: new Date(now.getTime() - SESSION_ABSOLUTE_TTL_MS), expiresAt: new Date(now.getTime() + 1) }, now)).toBe(true);
    expect(SESSION_TOUCH_INTERVAL_MS).toBe(60 * 60 * 1000);
    expect(shouldTouch(new Date(now.getTime() - 59 * 60 * 1000), now)).toBe(false);
    expect(shouldTouch(new Date(now.getTime() - SESSION_TOUCH_INTERVAL_MS), now)).toBe(true);
  });

  it('limits a touch to the absolute deadline', () => {
    const createdAt = new Date(now.getTime() - 59 * 24 * 60 * 60 * 1000);
    expect(touchedExpiresAt({ createdAt, lastUsedAt: now }, now)).toEqual(absoluteDeadline(createdAt));
  });

  it('touches a live session and deletes a revoked or expired session', async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn().mockResolvedValue({
      id: 'session-id',
      createdAt: now,
      lastUsedAt: new Date(now.getTime() - SESSION_TOUCH_INTERVAL_MS),
      expiresAt: new Date(now.getTime() + SESSION_IDLE_TTL_MS),
      client: { id: 'client-id', email: 'client@example.invalid', emailVerifiedAt: null },
    });
    const db = { session: { findUnique, update, deleteMany } } as unknown as Db;

    const found = await findSession(db, 'opaque-token', now);
    expect(found?.client.id).toBe('client-id');
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]?.[0].data).toMatchObject({ lastUsedAt: now });

    await revokeSession(db, 'opaque-token');
    expect(deleteMany).toHaveBeenCalledWith({ where: { tokenHash: expect.any(String) } });

    findUnique.mockResolvedValueOnce({
      id: 'expired-id',
      createdAt: new Date(now.getTime() - SESSION_ABSOLUTE_TTL_MS),
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + SESSION_IDLE_TTL_MS),
      client: { id: 'client-id', email: 'client@example.invalid', emailVerifiedAt: null },
    });
    expect(await findSession(db, 'expired-token', now)).toBeNull();
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: 'expired-id' } });
  });
});
