import {
  apiErrorSchema,
  authResponseSchema,
  loginRequestSchema,
  okResponseSchema,
  registerRequestSchema,
} from '@hair-lab/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth, SESSION_COOKIE_NAME } from '../../shared/auth';
import { buildError } from '../../shared/http/error-handler';
import {
  EmailTakenError,
  InvalidCredentialsError,
  loginClient,
  logoutClient,
  me,
  registerClient,
} from './auth.service';

/**
 * Маршруты аккаунта клиента: регистрация, вход, выход, текущий клиент.
 *
 * Сессия выдаётся cookie (`hl_session`, httpOnly), в теле ответа токена нет — клиент
 * его не хранит и не разбирает. Тело запроса содержит пароль: Fastify его не логирует,
 * а мы не пишем в логи ни тело, ни email.
 *
 * Лимиты запросов per-route (плагин `@fastify/rate-limit` регистрируется с `global: false`):
 * регистрация — 5 в час на IP, вход — 10 в минуту на IP. Это защита от перебора пароля
 * и от массового создания аккаунтов; ключ — IP, который приходит от nginx (`trustProxy`).
 */

/** Регистрация: 5 запросов в час на IP. */
export const REGISTER_RATE_LIMIT = { max: 5, timeWindow: '1 hour' } as const;

/** Вход: 10 запросов в минуту на IP — перебор пароля должен быть невыгоден. */
export const LOGIN_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/auth/register',
    {
      config: { rateLimit: REGISTER_RATE_LIMIT },
      schema: {
        tags: ['auth'],
        summary: 'Регистрация клиента (сессия в httpOnly cookie)',
        body: registerRequestSchema,
        response: {
          201: authResponseSchema,
          409: apiErrorSchema,
          429: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { client, token } = await registerClient(app.db, request.body);
        reply.setSessionCookie(token);
        return reply.status(201).send({ client });
      } catch (error) {
        // `conflict` не выводится из 409 автоматически с нужным смыслом — тело собираем явно.
        if (error instanceof EmailTakenError) {
          return reply.status(409).send(buildError('conflict', request.id));
        }
        throw error;
      }
    },
  );

  app.post(
    '/auth/login',
    {
      config: { rateLimit: LOGIN_RATE_LIMIT },
      schema: {
        tags: ['auth'],
        summary: 'Вход клиента по почте и паролю',
        body: loginRequestSchema,
        response: {
          200: authResponseSchema,
          401: apiErrorSchema,
          429: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { client, token } = await loginClient(app.db, request.body);
        reply.setSessionCookie(token);
        return reply.status(200).send({ client });
      } catch (error) {
        if (error instanceof InvalidCredentialsError) {
          return reply.status(401).send(buildError('unauthorized', request.id));
        }
        throw error;
      }
    },
  );

  app.post(
    '/auth/logout',
    {
      schema: {
        tags: ['auth'],
        summary: 'Выход: удаление сессии и очистка cookie',
        response: { 200: okResponseSchema },
      },
    },
    async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE_NAME];
      if (token !== undefined && token.length > 0) {
        await logoutClient(app.db, token);
      }
      // Cookie чистим всегда: даже если сессии уже нет, браузер не должен её хранить.
      reply.clearSessionCookie();
      return { ok: true as const };
    },
  );

  app.get(
    '/auth/me',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['auth'],
        summary: 'Текущий клиент по cookie сессии',
        response: { 200: authResponseSchema, 401: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const client = request.authClient;
      // preHandler уже проверил сессию; ветка нужна только для сужения типа.
      if (client === null) {
        return reply.status(401).send(buildError('unauthorized', request.id));
      }
      return { client: me(client) };
    },
  );
};
