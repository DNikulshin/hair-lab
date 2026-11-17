import {
  apiErrorSchema,
  okResponseSchema,
  staffAuthResponseSchema,
  staffLoginRequestSchema,
} from '@hair-lab/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { makeRequireStaff, STAFF_SESSION_COOKIE_NAME } from '../../shared/auth';
import { buildError } from '../../shared/http/error-handler';
import {
  loginStaff,
  logoutStaff,
  meStaff,
  StaffInvalidCredentialsError,
} from './staff-auth.service';

/**
 * Вход сотрудника: один и тот же лимит по IP, что у клиентского входа (10 запросов в минуту).
 * Считается по адресу клиента (`trustProxy: true` в сборке сервера): за nginx иначе все
 * попытки схлопнулись бы в один IP прокси.
 */
export const STAFF_LOGIN_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

/**
 * Плагин staff-auth: вход, выход и текущий сотрудник. Все ответы — через `staffAuthResponseSchema`
 * (только id, email и роль: пароля и его хеша в ответах нет).
 *
 * CSRF закрыт глобальным Origin-guard'ом плагина аутентификации: unsafe-метод с чужим
 * `Origin` получает 403 ещё до обработчика.
 */
export const staffAuthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/staff/auth/login',
    {
      config: { rateLimit: STAFF_LOGIN_RATE_LIMIT },
      schema: {
        tags: ['staff'],
        summary: 'Вход сотрудника (сессия в httpOnly cookie hl_staff_session)',
        body: staffLoginRequestSchema,
        response: { 200: staffAuthResponseSchema, 401: apiErrorSchema, 429: apiErrorSchema },
      },
    },
    async (request, reply) => {
      try {
        const { staff, token } = await loginStaff(app.db, request.body);
        reply.setStaffSessionCookie(token);
        return reply.status(200).send({ staff });
      } catch (error) {
        if (error instanceof StaffInvalidCredentialsError) {
          return reply.status(401).send(buildError('unauthorized', request.id));
        }
        throw error;
      }
    },
  );

  app.post(
    '/staff/auth/logout',
    {
      schema: {
        tags: ['staff'],
        summary: 'Выход сотрудника: удаление сессии и очистка cookie',
        response: { 200: okResponseSchema },
      },
    },
    async (request, reply) => {
      const cookieToken = request.cookies[STAFF_SESSION_COOKIE_NAME];
      if (cookieToken !== undefined && cookieToken.length > 0) {
        await logoutStaff(app.db, cookieToken);
      }
      reply.clearStaffSessionCookie();
      return { ok: true as const };
    },
  );

  app.get(
    '/staff/me',
    {
      preHandler: makeRequireStaff(),
      schema: {
        tags: ['staff'],
        summary: 'Текущий сотрудник по cookie сессии (любая роль)',
        response: { 200: staffAuthResponseSchema, 401: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const staff = request.authStaff;
      // preHandler уже отдал 401 без сессии: сюда `null` попасть не может, но тип сужаем.
      if (staff === null) return reply.status(401).send(buildError('unauthorized', request.id));
      return { staff: meStaff(staff) };
    },
  );
};
