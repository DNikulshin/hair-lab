import {
  adminAppointmentResponseSchema,
  adminAppointmentsQuerySchema,
  adminAppointmentsResponseSchema,
  adminCancelRequestSchema,
  apiErrorSchema,
  idSchema,
  maskPhone,
  type AdminAppointment,
} from '@hair-lab/contracts';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { makeRequireStaff } from '../../shared/auth';
import { buildError } from '../../shared/http/error-handler';
import {
  cancelAdminAppointment,
  completeAdminAppointment,
  confirmAdminAppointment,
  listAdminAppointments,
  markAdminAppointmentNoShow,
} from './admin-appointments.service';

/**
 * Админка: записи на день и действия над ними (#242).
 *
 * Все маршруты закрыты `makeRequireStaff()` без ограничения роли (матрица ролей — отдельная
 * задача): без cookie `hl_staff_session` — 401, деактивированный сотрудник — тоже 401.
 * Клиентская cookie `hl_session` staff-маршруты не открывает: субъекты и сессии разные.
 *
 * ПДн: полный телефон клиента отдаётся только в ответе авторизованному сотруднику. В логи
 * попадают лишь идентификаторы (запрос, сотрудник, запись), статус и телефон **маской** —
 * имя и почта клиента не логируются вовсе.
 *
 * Ошибки перехода отдают единый формат `apiErrorSchema`: 404 `not_found` — записи нет,
 * 409 `conflict` — переход из текущего статуса недопустим. Повтор уже выполненного
 * действия — 200 с текущим состоянием записи.
 */

/** Действия без тела: подтверждение, завершение и неявка. */
const bodylessActions = [
  {
    path: 'confirm',
    summary: 'Подтверждение записи (pending → confirmed)',
    run: confirmAdminAppointment,
  },
  {
    path: 'complete',
    summary: 'Визит состоялся (pending|confirmed → completed)',
    run: completeAdminAppointment,
  },
  {
    path: 'no-show',
    summary: 'Клиент не пришёл (pending|confirmed → no_show)',
    run: markAdminAppointmentNoShow,
  },
] as const;

/** Лог перехода: только служебные идентификаторы и маска телефона, без ПДн. */
function logTransition(
  request: FastifyRequest,
  staffId: string,
  appointment: AdminAppointment,
): void {
  request.log.info(
    {
      requestId: request.id,
      staffId,
      appointmentId: appointment.id,
      status: appointment.status,
      clientPhoneMasked: maskPhone(appointment.clientPhone),
    },
    'admin: действие над записью',
  );
}

export const adminAppointmentsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/admin/appointments',
    {
      preHandler: makeRequireStaff(),
      schema: {
        tags: ['admin'],
        summary: 'Записи на день в часовом поясе салона',
        querystring: adminAppointmentsQuerySchema,
        response: { 200: adminAppointmentsResponseSchema, 401: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const staff = request.authStaff;
      // preHandler уже отдал 401 без сессии: сюда `null` попасть не может, но тип сужаем.
      if (staff === null) return reply.status(401).send(buildError('unauthorized', request.id));

      const response = await listAdminAppointments(app.db, request.query.date);
      request.log.info(
        {
          requestId: request.id,
          staffId: staff.id,
          date: request.query.date,
          items: response.items.length,
        },
        'admin: список записей дня',
      );
      return response;
    },
  );

  for (const action of bodylessActions) {
    app.post(
      `/admin/appointments/:id/${action.path}`,
      {
        preHandler: makeRequireStaff(),
        schema: {
          tags: ['admin'],
          summary: action.summary,
          params: z.object({ id: idSchema }),
          response: {
            200: adminAppointmentResponseSchema,
            401: apiErrorSchema,
            404: apiErrorSchema,
            409: apiErrorSchema,
          },
        },
      },
      async (request, reply) => {
        const staff = request.authStaff;
        if (staff === null) return reply.status(401).send(buildError('unauthorized', request.id));

        const booking = await action.run(app.db, request.params.id);
        logTransition(request, staff.id, booking);
        return { booking };
      },
    );
  }

  app.post(
    '/admin/appointments/:id/cancel',
    {
      preHandler: makeRequireStaff(),
      schema: {
        tags: ['admin'],
        summary: 'Отмена салоном с причиной (pending|confirmed → cancelled)',
        params: z.object({ id: idSchema }),
        body: adminCancelRequestSchema,
        response: {
          200: adminAppointmentResponseSchema,
          400: apiErrorSchema,
          401: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const staff = request.authStaff;
      if (staff === null) return reply.status(401).send(buildError('unauthorized', request.id));

      const booking = await cancelAdminAppointment(app.db, request.params.id, request.body.reason);
      logTransition(request, staff.id, booking);
      return { booking };
    },
  );
};
