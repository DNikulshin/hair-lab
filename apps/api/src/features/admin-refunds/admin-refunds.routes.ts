import {
  adminRefundsQuerySchema,
  adminRefundsResponseSchema,
  apiErrorSchema,
  type StaffRole,
} from '@hair-lab/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { makeRequireStaff } from '../../shared/auth';
import { buildError } from '../../shared/http/error-handler';
import { listAdminRefunds } from './admin-refunds.service';

/**
 * Админка: обзор возвратов (#298) — `GET /admin/refunds`.
 *
 * Маршрут закрыт `makeRequireStaff(...)` по матрице ролей (#252, `docs/decisions.md`):
 * без cookie `hl_staff_session` — 401, деактивированный сотрудник — тоже 401, роль не из
 * матрицы — 403 `forbidden`. Клиентская cookie `hl_session` staff-маршрут не открывает.
 *
 * Это обзор, а не проведение возврата: деньги возвращает свипер и обработчик уведомления
 * (`payments`), маршрут ничего не меняет в БД.
 *
 * ПДн: полный телефон клиента отдаётся только в ответе авторизованному сотруднику. В лог
 * попадают лишь идентификатор запроса, сотрудник, scope и число строк — ни имени, ни
 * телефона, ни почты клиента там нет.
 */

/**
 * Матрица ролей обзора возвратов (#252): обе роли видят список. Обзор — чтение, денег он
 * не двигает; разбор возврата проводит администратор. Зафиксировано в `docs/decisions.md`.
 */
const REFUND_VIEW_ROLES: readonly StaffRole[] = ['admin', 'manager'];

export const adminRefundsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/admin/refunds',
    {
      preHandler: makeRequireStaff(REFUND_VIEW_ROLES),
      schema: {
        tags: ['admin'],
        summary: 'Обзор возвратов: требуют внимания или возвращённые',
        querystring: adminRefundsQuerySchema,
        response: {
          200: adminRefundsResponseSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          403: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const staff = request.authStaff;
      // preHandler уже отдал 401 без сессии: сюда `null` попасть не может, но тип сужаем.
      if (staff === null) return reply.status(401).send(buildError('unauthorized', request.id));

      const response = await listAdminRefunds(app.db, request.query);
      request.log.info(
        {
          requestId: request.id,
          staffId: staff.id,
          scope: request.query.scope,
          items: response.items.length,
        },
        'admin: обзор возвратов',
      );
      return response;
    },
  );
};
