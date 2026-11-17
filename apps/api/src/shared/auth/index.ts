/**
 * Публичный API модуля аутентификации (shared): пароли, токены, сессии, плагин и CSRF.
 * Импортировать только из серверного кода `apps/api`; фичи не импортируют друг друга напрямую.
 */
export { createOriginAllowList, isOriginAllowed, normalizeOrigin } from './csrf';
export {
  ARGON2_OPTIONS,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyDummyPassword,
  verifyPassword,
} from './password';
export {
  default as authPlugin,
  makeRequireStaff,
  requireAuth,
  SESSION_COOKIE_NAME,
  STAFF_SESSION_COOKIE_NAME,
  type AuthPluginOptions,
} from './plugin';
export {
  createSession,
  findSession,
  revokeAllForClient,
  revokeSession,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_TOUCH_INTERVAL_MS,
  type AuthClient,
  type CreatedSession,
  type FoundSession,
} from './session';
export { createSessionToken, hashToken, SESSION_TOKEN_BYTES } from './tokens';
export {
  createStaffSession,
  findStaffSession,
  isStaffSessionExpired,
  revokeStaffSession,
  STAFF_SESSION_ABSOLUTE_TTL_MS,
  STAFF_SESSION_IDLE_TTL_MS,
  staffAbsoluteDeadline,
  staffIdleExpiresAt,
  type AuthStaff,
  type CreatedStaffSession,
  type FoundStaffSession,
} from './staff-session';
