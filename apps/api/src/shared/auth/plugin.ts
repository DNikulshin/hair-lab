import cookie from '@fastify/cookie';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { buildError } from '../http/error-handler';
import { registerOriginGuard } from './csrf';
import { findSession, SESSION_ABSOLUTE_TTL_MS, type AuthClient } from './session';

/**
 * Плагин аутентификации клиента: cookie, сессия в запросе и CSRF-проверка.
 *
 * Что делает:
 * - регистрирует `@fastify/cookie` (без подписи: токен и так случайный, а подпись — ещё один
 *   секрет в конфиге; в БД лежит только SHA-256 токена);
 * - один раз за запрос резолвит сессию из cookie `hl_session` в `request.authClient`
 *   (при необходимости продлевая срок). Невалидная или просроченная cookie не ошибка —
 *   просто нет клиента, а cookie очищается, чтобы браузер не отправлял мусор;
 * - проверяет `Origin`/`Referer` на unsafe-методах (CSRF);
 * - даёт `requireAuth` (preHandler → 401), `reply.setSessionCookie` и `reply.clearSessionCookie`.
 *
 * Cookie: HttpOnly (JS не читает токен), SameSite=Lax (межсайтовый POST её не отправит),
 * Path=/ (сессия нужна и API, и страницам SSR), Secure в production (сайт за HTTPS).
 * Токен в логи не попадает: заголовки не логируются, значения cookie не выводятся.
 */

/** Имя cookie сессии. */
export const SESSION_COOKIE_NAME = 'hl_session';

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
  }

  interface FastifyReply {
    /** Выдать cookie сессии. Срок cookie — максимальный срок жизни сессии. */
    setSessionCookie(token: string): FastifyReply;
    /** Очистить cookie сессии (выход, невалидная cookie). */
    clearSessionCookie(): FastifyReply;
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
};

export default fp(authPlugin, { name: 'auth', dependencies: ['db'] });
