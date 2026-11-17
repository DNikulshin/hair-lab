import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PasswordModule from '../../shared/auth/password';
import type { Db } from '../../shared/db';
import { hashPassword, verifyDummyPassword } from '../../shared/auth/password';
import { hashToken } from '../../shared/auth/tokens';
import { STAFF_SESSION_IDLE_TTL_MS } from '../../shared/auth/staff-session';
import {
  loginStaff,
  logoutStaff,
  meStaff,
  StaffInvalidCredentialsError,
} from './staff-auth.service';

/**
 * Модуль паролей частично подменяется: dummy-verify на неизвестный email нужен как факт
 * (`toHaveBeenCalled`), а не как 50 мс настоящего argon2. Проверка пароля работает по-настоящему.
 */
vi.mock('../../shared/auth/password', async (importOriginal) => {
  const actual = await importOriginal<typeof PasswordModule>();
  return { ...actual, verifyDummyPassword: vi.fn(async () => undefined) };
});

/** Вымышленные данные: реальных сотрудников и паролей в тестах нет. */
const email = 'staff@example.invalid';
const password = 'test-password-0001';
const staffId = '55555555-5555-4555-8555-555555555555';

/** Заглушка БД: `staff` для поиска учётной записи и `staffSession` для выдачи/отзыва сессии. */
function staffDb(row: unknown) {
  const findUnique = vi.fn().mockResolvedValue(row);
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const create = vi.fn().mockResolvedValue({ id: 'session-id' });
  const db = { staff: { findUnique }, staffSession: { deleteMany, create } } as unknown as Db;
  return { db, findUnique, deleteMany, create };
}

beforeEach(() => {
  vi.mocked(verifyDummyPassword).mockClear();
});

describe('loginStaff', () => {
  it('issues a session for an active employee and returns no password fields', async () => {
    const passwordHash = await hashPassword(password);
    const { db, create } = staffDb({
      id: staffId,
      email,
      role: 'manager',
      isActive: true,
      passwordHash,
    });

    const result = await loginStaff(db, { email, password });

    expect(result.staff).toEqual({ id: staffId, email, role: 'manager' });
    expect(JSON.stringify(result)).not.toContain(passwordHash);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(result.token.length).toBeGreaterThan(20);
    expect(create).toHaveBeenCalledOnce();
    const data = create.mock.calls[0]?.[0].data as { staffId: string; expiresAt: Date };
    expect(data.staffId).toBe(staffId);
    // Срок фиксирован на входе: ровно один рабочий день, дальше не продлевается.
    const ttl = data.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(STAFF_SESSION_IDLE_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(STAFF_SESSION_IDLE_TTL_MS);
  });

  it('runs a dummy verify for an unknown email and gives the same error as a wrong password', async () => {
    const unknown = staffDb(null);
    const unknownError = await loginStaff(unknown.db, { email, password }).catch(
      (error: unknown) => error,
    );

    const wrongPassword = staffDb({
      id: staffId,
      email,
      role: 'admin',
      isActive: true,
      passwordHash: await hashPassword('another-password-0002'),
    });
    const wrongPasswordError = await loginStaff(wrongPassword.db, { email, password }).catch(
      (error: unknown) => error,
    );

    expect(unknownError).toBeInstanceOf(StaffInvalidCredentialsError);
    expect(wrongPasswordError).toBeInstanceOf(StaffInvalidCredentialsError);
    // Ответ одинаковый: по нему нельзя понять, существует ли учётная запись.
    expect((unknownError as Error).message).toBe((wrongPasswordError as Error).message);
    expect((unknownError as StaffInvalidCredentialsError).statusCode).toBe(401);
    expect(verifyDummyPassword).toHaveBeenCalledWith(password);
    expect(unknown.create).not.toHaveBeenCalled();
    expect(wrongPassword.create).not.toHaveBeenCalled();
  });

  it('rejects a correct password of a deactivated employee with the same 401', async () => {
    const { db, create } = staffDb({
      id: staffId,
      email,
      role: 'admin',
      isActive: false,
      passwordHash: await hashPassword(password),
    });

    await expect(loginStaff(db, { email, password })).rejects.toBeInstanceOf(
      StaffInvalidCredentialsError,
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe('logoutStaff and meStaff', () => {
  it('returns the employee DTO without password fields', () => {
    expect(meStaff({ id: staffId, email, role: 'admin', isActive: true })).toEqual({
      id: staffId,
      email,
      role: 'admin',
    });
  });

  it('revokes the session by token hash', async () => {
    const { db, deleteMany } = staffDb(null);

    await logoutStaff(db, 'opaque-token');

    expect(deleteMany).toHaveBeenCalledWith({ where: { tokenHash: hashToken('opaque-token') } });
  });
});
