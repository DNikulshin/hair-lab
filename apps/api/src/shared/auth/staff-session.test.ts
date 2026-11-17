import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db';
import { hashToken } from './tokens';
import {
  createStaffSession,
  findStaffSession,
  isStaffSessionExpired,
  revokeStaffSession,
  STAFF_SESSION_ABSOLUTE_TTL_MS,
  STAFF_SESSION_IDLE_TTL_MS,
  staffAbsoluteDeadline,
  staffIdleExpiresAt,
} from './staff-session';

const now = new Date('2030-01-01T08:00:00.000Z');
const hour = 60 * 60 * 1000;

/**
 * Заглушка БД без `update`: сессия сотрудника не продлевается, поэтому обращение к
 * `staffSession.update` из кода уронило бы тест — это и есть проверка «не touch».
 */
function staffSessionDb(row: unknown) {
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const create = vi.fn().mockResolvedValue({ id: 'created-session' });
  const findUnique = vi.fn().mockResolvedValue(row);
  return {
    db: { staffSession: { deleteMany, create, findUnique } } as unknown as Db,
    deleteMany,
    create,
    findUnique,
  };
}

describe('staff session TTL policy', () => {
  it('keeps a working day: 8 hours idle and 12 hours absolute', () => {
    expect(STAFF_SESSION_IDLE_TTL_MS).toBe(8 * hour);
    expect(STAFF_SESSION_ABSOLUTE_TTL_MS).toBe(12 * hour);
    expect(staffIdleExpiresAt(now)).toEqual(new Date(now.getTime() + 8 * hour));
    expect(staffAbsoluteDeadline(now)).toEqual(new Date(now.getTime() + 12 * hour));
  });

  it('expires on the idle deadline or the absolute deadline, boundary included', () => {
    const createdAt = new Date(now.getTime() - hour);
    expect(isStaffSessionExpired({ createdAt, expiresAt: new Date(now.getTime() + 1) }, now)).toBe(
      false,
    );
    expect(isStaffSessionExpired({ createdAt, expiresAt: now }, now)).toBe(true);
    expect(
      isStaffSessionExpired(
        {
          createdAt: new Date(now.getTime() - STAFF_SESSION_ABSOLUTE_TTL_MS),
          expiresAt: new Date(now.getTime() + 1),
        },
        now,
      ),
    ).toBe(true);
  });
});

describe('staff session storage', () => {
  it('stores only a SHA-256 hash of the token and clears expired rows on login', async () => {
    const { db, create, deleteMany } = staffSessionDb(null);

    const created = await createStaffSession(db, 'staff-id', now);

    expect(deleteMany).toHaveBeenCalledWith({
      where: { staffId: 'staff-id', expiresAt: { lte: now } },
    });
    expect(created.expiresAt).toEqual(staffIdleExpiresAt(now));
    const data = create.mock.calls[0]?.[0].data as {
      tokenHash: string;
      staffId: string;
      expiresAt: Date;
      lastUsedAt: Date;
    };
    // В БД — только хеш: сырой токен из cookie нигде не хранится.
    expect(data.tokenHash).toBe(hashToken(created.token));
    expect(data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.tokenHash).not.toBe(created.token);
    expect(data).toMatchObject({
      staffId: 'staff-id',
      expiresAt: created.expiresAt,
      lastUsedAt: now,
    });
  });

  it('resolves a live session without touching it (no extension on access)', async () => {
    const { db, deleteMany } = staffSessionDb({
      id: 'session-id',
      createdAt: new Date(now.getTime() - hour),
      expiresAt: new Date(now.getTime() + hour),
      staff: { id: 'staff-id', email: 'staff@example.invalid', role: 'admin', isActive: true },
    });

    const found = await findStaffSession(db, 'opaque-token', now);

    expect(found).toEqual({
      sessionId: 'session-id',
      staff: { id: 'staff-id', email: 'staff@example.invalid', role: 'admin', isActive: true },
    });
    // Заглушка БД вообще не имеет `update`: любое продление сломало бы тест.
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('deletes an expired session and returns null', async () => {
    const { db, deleteMany } = staffSessionDb({
      id: 'expired-session',
      createdAt: new Date(now.getTime() - 9 * hour),
      expiresAt: new Date(now.getTime() - hour),
      staff: { id: 'staff-id', email: 'staff@example.invalid', role: 'manager', isActive: true },
    });

    expect(await findStaffSession(db, 'expired-token', now)).toBeNull();
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: 'expired-session' } });
  });

  it('returns null for an unknown token and revokes idempotently', async () => {
    const { db, deleteMany, findUnique } = staffSessionDb(null);

    expect(await findStaffSession(db, 'unknown-token', now)).toBeNull();

    await revokeStaffSession(db, 'opaque-token');
    expect(deleteMany).toHaveBeenCalledWith({ where: { tokenHash: hashToken('opaque-token') } });
    // Поиск идёт по хешу: сырого токена в запросе к БД нет.
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashToken('unknown-token') } }),
    );
  });
});
