import type { Db } from '../db';
import { createSessionToken, hashToken } from './tokens';

/**
 * Сессии входа клиента (opaque-токен в httpOnly cookie, в БД — только SHA-256 токена).
 *
 * Сроки:
 * - бездействие (idle) — 14 дней: срок продлевается при обращении, но не чаще раза в час,
 *   иначе каждое открытие страницы писало бы в БД;
 * - абсолютный срок — 60 дней от создания сессии: не продлевается ничем, после него
 *   нужен новый вход (украденная cookie не живёт вечно).
 * `expires_at` хранит срок по бездействию, `created_at` — начало сессии: для абсолютного
 * срока отдельного поля не нужно.
 *
 * Просроченные строки удаляются лениво, без отдельной джобы: сессия, по которой пришёл
 * запрос, удаляется сразу, а при новом входе заодно вычищаются истёкшие сессии этого клиента.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Срок жизни сессии по бездействию. */
export const SESSION_IDLE_TTL_MS = 14 * DAY_MS;

/** Абсолютный срок жизни сессии: считается от создания и не продлевается. */
export const SESSION_ABSOLUTE_TTL_MS = 60 * DAY_MS;

/** Как часто обновляется `lastUsedAt` (не чаще одного раза в час). */
export const SESSION_TOUCH_INTERVAL_MS = HOUR_MS;

/** Клиент, от имени которого пришёл запрос. Поля — только то, что нужно API и SSR. */
export interface AuthClient {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
}

/** Найденная (и при необходимости продлённая) сессия. */
export interface FoundSession {
  sessionId: string;
  client: AuthClient;
}

/** Созданная сессия: токен уходит в cookie, в БД остаётся только его хеш. */
export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

/** Срок по бездействию от указанного момента. */
export function idleExpiresAt(now: Date): Date {
  return new Date(now.getTime() + SESSION_IDLE_TTL_MS);
}

/** Момент, после которого сессия недействительна независимо от активности. */
export function absoluteDeadline(createdAt: Date): Date {
  return new Date(createdAt.getTime() + SESSION_ABSOLUTE_TTL_MS);
}

/**
 * Просрочена ли сессия: истёк срок по бездействию (`expiresAt`) или прошёл абсолютный
 * срок от `createdAt`. Граница считается просроченной (`<=`).
 */
export function isSessionExpired(
  session: { createdAt: Date; expiresAt: Date },
  now: Date,
): boolean {
  return session.expiresAt.getTime() <= now.getTime() || absoluteDeadline(session.createdAt) <= now;
}

/** Пора ли обновить `lastUsedAt`: не чаще одного раза в час. */
export function shouldTouch(lastUsedAt: Date, now: Date): boolean {
  return now.getTime() - lastUsedAt.getTime() >= SESSION_TOUCH_INTERVAL_MS;
}

/** Новый срок сессии при обращении: продлеваем idle, но не дальше абсолютного срока. */
export function touchedExpiresAt(session: { createdAt: Date; lastUsedAt: Date }, now: Date): Date {
  const idle = idleExpiresAt(now).getTime();
  const absolute = absoluteDeadline(session.createdAt).getTime();
  return new Date(Math.min(idle, absolute));
}

/**
 * Создать сессию клиента. Заодно удаляются истёкшие сессии этого клиента —
 * так таблица не растёт бесконечно без отдельной джобы очистки.
 */
export async function createSession(
  db: Db,
  clientId: string,
  now: Date = new Date(),
): Promise<CreatedSession> {
  await db.session.deleteMany({ where: { clientId, expiresAt: { lte: now } } });

  const token = createSessionToken();
  const expiresAt = idleExpiresAt(now);

  await db.session.create({
    data: { tokenHash: hashToken(token), clientId, expiresAt, lastUsedAt: now },
  });

  return { token, expiresAt };
}

/**
 * Найти сессию по токену из cookie. Просроченная сессия удаляется и даёт `null`;
 * у живой сессии при необходимости продлевается срок (не чаще раза в час).
 */
export async function findSession(
  db: Db,
  token: string,
  now: Date = new Date(),
): Promise<FoundSession | null> {
  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
      client: { select: { id: true, email: true, emailVerifiedAt: true } },
    },
  });
  if (session === null) return null;

  if (isSessionExpired(session, now)) {
    await db.session.deleteMany({ where: { id: session.id } });
    return null;
  }

  if (shouldTouch(session.lastUsedAt, now)) {
    await db.session.update({
      where: { id: session.id },
      data: { lastUsedAt: now, expiresAt: touchedExpiresAt(session, now) },
    });
  }

  return { sessionId: session.id, client: session.client };
}

/** Выход: удалить сессию по токену. Отсутствие строки — не ошибка (идемпотентно). */
export async function revokeSession(db: Db, token: string): Promise<void> {
  await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

/** Выход со всех устройств: удалить все сессии клиента. Возвращает число удалённых. */
export async function revokeAllForClient(db: Db, clientId: string): Promise<number> {
  const { count } = await db.session.deleteMany({ where: { clientId } });
  return count;
}
