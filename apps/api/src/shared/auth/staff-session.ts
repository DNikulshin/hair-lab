import type { StaffRole } from '@hair-lab/contracts';
import type { Db } from '../db';
import { createSessionToken, hashToken } from './tokens';

/**
 * Сессии входа сотрудника (админка): opaque-токен в отдельной httpOnly cookie
 * `hl_staff_session`, в БД — только SHA-256 токена. Отдельная таблица и отдельная cookie
 * нужны, чтобы клиентская сессия (`hl_session`) не давала доступа к staff-маршрутам.
 *
 * Сроки — рабочий день:
 * - срок по бездействию — 8 часов от входа;
 * - абсолютный предел — 12 часов от создания сессии.
 * Сессия сотрудника **не продлевается** при обращениях: админка работает в течение смены,
 * а угнанная cookie не живёт дольше рабочего дня. Поэтому `lastUsedAt` заполняется только
 * при входе (поле оставлено для аудита — по нему видно начало сессии), а `expiresAt`
 * не переписывается.
 *
 * Просроченные строки удаляются лениво: сессия, по которой пришёл запрос, удаляется сразу,
 * а при новом входе заодно вычищаются истёкшие сессии этого сотрудника.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Срок жизни сессии сотрудника по бездействию: одна смена. */
export const STAFF_SESSION_IDLE_TTL_MS = 8 * HOUR_MS;

/** Абсолютный срок жизни сессии сотрудника: считается от создания и не продлевается. */
export const STAFF_SESSION_ABSOLUTE_TTL_MS = 12 * HOUR_MS;

/** Сотрудник, от имени которого пришёл запрос. Только то, что нужно API и проверке роли. */
export interface AuthStaff {
  id: string;
  email: string;
  role: StaffRole;
  /** Деактивированный сотрудник остаётся в сессии, но доступа не получает (401). */
  isActive: boolean;
}

/** Найденная сессия сотрудника. */
export interface FoundStaffSession {
  sessionId: string;
  staff: AuthStaff;
}

/** Созданная сессия: токен уходит в cookie, в БД остаётся только его хеш. */
export interface CreatedStaffSession {
  token: string;
  expiresAt: Date;
}

/** Срок по бездействию от указанного момента. */
export function staffIdleExpiresAt(now: Date): Date {
  return new Date(now.getTime() + STAFF_SESSION_IDLE_TTL_MS);
}

/** Момент, после которого сессия недействительна независимо от активности. */
export function staffAbsoluteDeadline(createdAt: Date): Date {
  return new Date(createdAt.getTime() + STAFF_SESSION_ABSOLUTE_TTL_MS);
}

/**
 * Просрочена ли сессия сотрудника: истёк срок по бездействию (`expiresAt`) или прошёл
 * абсолютный срок от `createdAt`. Граница считается просроченной (`<=`).
 */
export function isStaffSessionExpired(
  session: { createdAt: Date; expiresAt: Date },
  now: Date,
): boolean {
  return (
    session.expiresAt.getTime() <= now.getTime() || staffAbsoluteDeadline(session.createdAt) <= now
  );
}

/**
 * Создать сессию сотрудника. Заодно удаляются истёкшие сессии этого сотрудника —
 * так таблица не растёт бесконечно без отдельной джобы очистки.
 */
export async function createStaffSession(
  db: Pick<Db, 'staffSession'>,
  staffId: string,
  now: Date = new Date(),
): Promise<CreatedStaffSession> {
  await db.staffSession.deleteMany({ where: { staffId, expiresAt: { lte: now } } });

  const staffToken = createSessionToken();
  const expiresAt = staffIdleExpiresAt(now);

  await db.staffSession.create({
    data: { tokenHash: hashToken(staffToken), staffId, expiresAt, lastUsedAt: now },
  });

  return { token: staffToken, expiresAt };
}

/**
 * Найти сессию сотрудника по токену из cookie. Просроченная сессия удаляется и даёт `null`.
 * Живая сессия не продлевается: `expiresAt` остаётся тем, что записан при входе.
 */
export async function findStaffSession(
  db: Db,
  token: string,
  now: Date = new Date(),
): Promise<FoundStaffSession | null> {
  const session = await db.staffSession.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
      staff: { select: { id: true, email: true, role: true, isActive: true } },
    },
  });
  if (session === null) return null;

  if (isStaffSessionExpired(session, now)) {
    await db.staffSession.deleteMany({ where: { id: session.id } });
    return null;
  }

  return { sessionId: session.id, staff: session.staff };
}

/** Выход: удалить сессию по токену. Отсутствие строки — не ошибка (идемпотентно). */
export async function revokeStaffSession(db: Db, token: string): Promise<void> {
  await db.staffSession.deleteMany({ where: { tokenHash: hashToken(token) } });
}
