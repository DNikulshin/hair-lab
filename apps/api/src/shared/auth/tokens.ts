import { createHash, randomBytes } from 'node:crypto';

/**
 * Непрозрачные токены сессии.
 *
 * Токен — 32 случайных байта в base64url (256 бит энтропии): подобрать его нельзя,
 * а отозвать можно, удалив строку сессии (logout, «выйти со всех устройств»).
 * В БД хранится только SHA-256 от токена: утечка дампа не даёт готовых cookie,
 * а по хешу нельзя восстановить токен.
 *
 * Токен не логируется и не попадает в ответы API: наружу он уходит только в httpOnly cookie.
 */

/** Длина токена сессии в байтах: 32 байта = 43 символа base64url. */
export const SESSION_TOKEN_BYTES = 32;

/** Новый токен сессии (43 символа base64url). */
export function createSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/** SHA-256 токена в hex — то, что лежит в БД и по чему ищется сессия. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
