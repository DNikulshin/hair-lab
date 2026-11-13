import { createHash } from 'node:crypto';
import {
  apiErrorSchema,
  authResponseSchema,
  loginRequestSchema,
  magicLinkConsumeSchema,
  magicLinkRequestSchema,
  okResponseSchema,
  registerRequestSchema,
} from '@hair-lab/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { requireAuth, SESSION_COOKIE_NAME } from '../../shared/auth';
import { buildError } from '../../shared/http/error-handler';
import { consumeMagicLink, InvalidMagicLinkError, requestMagicLink } from './magic-link.service';
import type { TokenDeliveryRegistry } from './token-delivery';
import {
  EmailTakenError,
  InvalidCredentialsError,
  loginClient,
  logoutClient,
  me,
  registerClient,
} from './auth.service';

export interface AuthRoutesOptions {
  delivery: TokenDeliveryRegistry;
}

/** Registration: five requests per hour per IP. */
export const REGISTER_RATE_LIMIT = { max: 5, timeWindow: '1 hour' } as const;
/** Password login: ten requests per minute per IP. */
export const LOGIN_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;
/** Link requests: three per hour for each IP/email pair. */
export const MAGIC_LINK_RATE_LIMIT = {
  max: 3,
  timeWindow: '1 hour',
  hook: 'preHandler',
  keyGenerator: (request: { ip: string; body: unknown }) => {
    const parsed = magicLinkRequestSchema.safeParse(request.body);
    const emailHash = createHash('sha256')
      .update(parsed.success ? parsed.data.email : '')
      .digest('hex');
    return `${request.ip}:${emailHash}`;
  },
} as const;

export const authRoutes: FastifyPluginAsyncZod<AuthRoutesOptions> = async (app, options) => {
  app.post(
    '/auth/register',
    {
      config: { rateLimit: REGISTER_RATE_LIMIT },
      schema: {
        tags: ['auth'],
        summary: 'Регистрация клиента (сессия в httpOnly cookie)',
        body: registerRequestSchema,
        response: { 201: authResponseSchema, 409: apiErrorSchema, 429: apiErrorSchema },
      },
    },
    async (request, reply) => {
      try {
        const { client, token } = await registerClient(app.db, request.body, options.delivery);
        reply.setSessionCookie(token);
        return reply.status(201).send({ client });
      } catch (error) {
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
        summary: 'Вход клиента по почте и подтверждённому паролю',
        body: loginRequestSchema,
        response: { 200: authResponseSchema, 401: apiErrorSchema, 429: apiErrorSchema },
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
    '/auth/magic-link',
    {
      config: { rateLimit: MAGIC_LINK_RATE_LIMIT },
      schema: {
        tags: ['auth'],
        summary: 'Запрос одноразовой ссылки для входа и подтверждения почты',
        body: magicLinkRequestSchema,
        response: { 202: okResponseSchema, 429: apiErrorSchema },
      },
    },
    async (request, reply) => {
      await requestMagicLink(app.db, request.body.email, options.delivery);
      return reply.status(202).send({ ok: true });
    },
  );

  app.post(
    '/auth/magic-link/consume',
    {
      schema: {
        tags: ['auth'],
        summary: 'Проверка одноразовой ссылки, подтверждение почты и вход',
        body: magicLinkConsumeSchema,
        response: { 200: authResponseSchema, 401: apiErrorSchema },
      },
    },
    async (request, reply) => {
      try {
        const result = await consumeMagicLink(app.db, request.body, options.delivery);
        reply.setSessionCookie(result.token);
        return { client: me(result.client) };
      } catch (error) {
        if (error instanceof InvalidMagicLinkError) {
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
      if (token !== undefined && token.length > 0) await logoutClient(app.db, token);
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
      if (client === null) return reply.status(401).send(buildError('unauthorized', request.id));
      return { client: me(client) };
    },
  );
};
