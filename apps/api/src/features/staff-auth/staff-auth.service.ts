import type { StaffAccount, StaffLoginRequest } from '@hair-lab/contracts';
import {
  createStaffSession,
  revokeStaffSession,
  type AuthStaff,
} from '../../shared/auth/staff-session';
import { verifyDummyPassword, verifyPassword } from '../../shared/auth/password';
import type { Db } from '../../shared/db';

/**
 * Вход сотрудника в админку.
 *
 * Неверный пароль, неизвестный email и деактивированный сотрудник дают один и тот же
 * `StaffInvalidCredentialsError` (401 `unauthorized`): по ответу нельзя узнать, существует
 * ли учётная запись и активна ли она. На неизвестный email выполняется dummy-verify, чтобы
 * время ответа не выдавало наличие адреса.
 *
 * Пароль и хеш в лог не попадают: в сообщении ошибки значений нет, `verifyPassword`
 * возвращает только булево значение, а `StaffAccount` не содержит полей пароля.
 */
export class StaffInvalidCredentialsError extends Error {
  readonly statusCode = 401;

  constructor() {
    super('Неверная почта или пароль');
    this.name = 'StaffInvalidCredentialsError';
  }
}

/** Успешный вход: сотрудник для ответа и токен для cookie сессии. */
export interface StaffAuthResult {
  staff: StaffAccount;
  /** Токен сессии. Уходит только в httpOnly cookie и никуда не логируется. */
  token: string;
}

function toStaffAccount(row: {
  id: string;
  email: string;
  role: StaffAccount['role'];
}): StaffAccount {
  return { id: row.id, email: row.email, role: row.role };
}

/** Сотрудник текущей сессии в виде DTO (`GET /staff/me`). */
export function meStaff(staff: AuthStaff): StaffAccount {
  return toStaffAccount(staff);
}

/**
 * Вход по почте и паролю. Порядок проверок важен:
 * 1. неизвестный email — dummy-verify и 401 (время ответа как у существующего сотрудника);
 * 2. неверный пароль — 401 (проверяется до `isActive`, чтобы деактивация не была видна
 *    по времени ответа);
 * 3. деактивированный сотрудник — тот же 401: доступ закрыт, но учётная запись в БД остаётся
 *    (удаления нет, история сохраняется).
 */
export async function loginStaff(db: Db, dto: StaffLoginRequest): Promise<StaffAuthResult> {
  const staff = await db.staff.findUnique({
    where: { email: dto.email },
    select: { id: true, email: true, role: true, isActive: true, passwordHash: true },
  });

  if (staff === null) {
    await verifyDummyPassword(dto.password);
    throw new StaffInvalidCredentialsError();
  }
  if (!(await verifyPassword(staff.passwordHash, dto.password)) || !staff.isActive) {
    throw new StaffInvalidCredentialsError();
  }

  const { token } = await createStaffSession(db, staff.id);
  return { staff: toStaffAccount(staff), token };
}

/** Выход: удаляет сессию сотрудника по токену. Отсутствие сессии не ошибка. */
export async function logoutStaff(db: Db, token: string): Promise<void> {
  await revokeStaffSession(db, token);
}
