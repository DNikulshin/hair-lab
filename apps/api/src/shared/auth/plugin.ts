import cookie from '@fastify/cookie';
import type { StaffRole } from '@hair-lab/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { buildError } from '../http/error-handler';
import { registerOriginGuard } from './csrf';
import { findSession, SESSION_ABSOLUTE_TTL_MS, type AuthClient } from './session';
import { findStaffSession, STAFF_SESSION_ABSOLUTE_TTL_MS, type AuthStaff } from './staff-session';

/**
 * Плагин аутентификации: cookie, сессии в запросе и CSRF-проверка.
 *
 * Что делает:
 * - регистрирует `@fastify/cookie` (без подписи: токен и так случайный, а подпись — ещё один
 *   секрет в конфиге; в БД лежит только SHA-256 токена);
 * - один раз за запрос резолвит сессию из cookie `hl_session` в `request.authClient`
 *   (при необходимости продлевая срок), а из cookie `hl_staff_session` — в `request.authStaff`
 *   (без продления: сессия сотрудника живёт рабочий день). Невалидная или просроченная cookie
 *   не ошибка — просто нет соответствующего субъекта, а cookie очищается, чтобы браузер
 *   не отправлял мусор;
 * - проверяет `Origin`/`Referer` на unsafe-методах (CSRF);
 * - даёт `requireAuth` и `makeRequireStaff(roles?)` (preHandler → 401/403),
 *   `reply.setSessionCookie`/`clearSessionCookie`, `reply.setStaffSessionCookie`/`clearStaffSessionCookie`.
 *
 * Cookie клиента и сотрудника — разные (`hl_session` и `hl_staff_session`), с одинаковыми
 * атрибутами: HttpOnly (JS не читает токен), SameSite=Lax (межсайтовый POST её не отправит),
 * Path=/ (сессия нужна и API, и страницам SSR), Secure в production (сайт за HTTPS).
 * Токен в логи не попадает: заголовки не логируются, значения cookie не выводятся.
 */

/** Имя cookie сессии клиента. */
export const SESSION_COOKIE_NAME = 'hl_session';

/**
 * Имя cookie сессии сотрудника. Отдельная cookie, а не флаг в клиентской: клиентская сессия
 * (`hl_session`) не должна открывать staff-маршруты, а сотрудник — не клиент.
 */
export const STAFF_SESSION_COOKIE_NAME = 'hl_staff_session';

export interface AuthPluginOptions {
  /** `Secure` у cookie: включается в production (nginx отдаёт сайт по HTTPS). */
  secureCookies: boolean;
  /** Origin'ы, которым разрешены unsafe-методы: `origin(APP_URL)` ∪ `CORS_ORIGINS`. */
  allowedOrigins: readonly string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Клиент текущей сессии или `null`, если валидной cookie нет. */
    authClient: AuthClient | null;
    /** Сотрудник текущей сессии (`hl_staff_session`) или `null`. */
    authStaff: AuthStaff | null;
  }

  interface FastifyReply {
    /** Выдать cookie сессии. Срок cookie — максимальный срок жизни сессии. */
    setSessionCookie(token: string): FastifyReply;
    /** Очистить cookie сессии (выход, невалидная cookie). */
    clearSessionCookie(): FastifyReply;
    /** Выдать cookie сессии сотрудника. Срок cookie — абсолютный срок сессии. */
    setStaffSessionCookie(token: string): FastifyReply;
    /** Очистить cookie сессии сотрудника (выход, невалидная cookie). */
    clearStaffSessionCookie(): FastifyReply;
  }
}

/**
 * preHandler для маршрутов, доступных только с сессией: без клиента — 401 `unauthorized`.
 * Текст нейтральный: причину (нет cookie, просрочена, отозвана) не раскрываем.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.authClient !== null) return;
  await reply.status(401).send(buildError('unauthorized', request.id));
}

/**
 * preHandler для staff-маршрутов: без сессии сотрудника или при деактивированном
 * сотруднике — 401, роль не из списка — 403. Без аргумента допускает любую роль.
 *
 * Ответы нейтральные: причину (нет cookie, просрочена, отозвана, деактивирован) не раскрываем,
 * а клиентская cookie `hl_session` сюда не относится — у сотрудника своя cookie и своя сессия.
 */
export function makeRequireStaff(
  roles?: readonly StaffRole[],
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function requireStaff(request, reply) {
    const staff = request.authStaff;
    if (staff === null || !staff.isActive) {
      await reply.status(401).send(buildError('unauthorized', request.id));
      return;
    }
    if (roles !== undefined && !roles.includes(staff.role)) {
      await reply.status(403).send(buildError('forbidden', request.id));
    }
  };
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, options) => {
  // Регистрируем первым: парсинг cookie — тоже onRequest-хук, он должен идти до наших.
  await app.register(cookie);

  const attributes = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: options.secureCookies,
  } as const;

  app.decorateRequest('authClient', null);
  app.decorateRequest('authStaff', null);

  app.decorateReply('setSessionCookie', function (this: FastifyReply, token: string) {
    // Max-Age cookie = абсолютный срок сессии: сама сессия может закончиться раньше
    // (idle 14 дней), но браузер не должен терять cookie раньше срока жизни аккаунта в сессии.
    return this.setCookie(SESSION_COOKIE_NAME, token, {
      ...attributes,
      maxAge: Math.floor(SESSION_ABSOLUTE_TTL_MS / 1000),
    });
  });

  app.decorateReply('clearSessionCookie', function (this: FastifyReply) {
    return this.clearCookie(SESSION_COOKIE_NAME, attributes);
  });

  app.decorateReply('setStaffSessionCookie', function (this: FastifyReply, token: string) {
    return this.setCookie(STAFF_SESSION_COOKIE_NAME, token, {
      ...attributes,
      maxAge: Math.floor(STAFF_SESSION_ABSOLUTE_TTL_MS / 1000),
    });
  });

  app.decorateReply('clearStaffSessionCookie', function (this: FastifyReply) {
    return this.clearCookie(STAFF_SESSION_COOKIE_NAME, attributes);
  });

  registerOriginGuard(app, options.allowedOrigins);

  app.addHook('onRequest', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (token === undefined || token.length === 0) return;

    const session = await findSession(app.db, token);
    if (session === null) {
      reply.clearSessionCookie();
      return;
    }

    request.authClient = session.client;
  });

  // Сессия сотрудника разрешается отдельно и независимо от клиентской: cookie разные,
  // таблицы разные. Деактивированный сотрудник остаётся в `authStaff` (isActive = false):
  // 401 по нему отдаёт `makeRequireStaff`, чтобы правило было в одном месте.
  app.addHook('onRequest', async (request, reply) => {
    const cookieToken = request.cookies[STAFF_SESSION_COOKIE_NAME];
    if (cookieToken === undefined || cookieToken.length === 0) return;

    const session = await findStaffSession(app.db, cookieToken);
    if (session === null) {
      reply.clearStaffSessionCookie();
      return;
    }

    request.authStaff = session.staff;
  });
};

export default fp(authPlugin, { name: 'auth', dependencies: ['db'] });
