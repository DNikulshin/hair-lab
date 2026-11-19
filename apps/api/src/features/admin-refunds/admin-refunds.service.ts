import type {
  AdminRefundItem,
  AdminRefundsResponse,
  AdminRefundsScope,
  BookingStatus,
} from '@hair-lab/contracts';
import { env } from '../../shared/config/env';
import type { Db } from '../../shared/db';
// Границы календарного дня в TZ салона — через публичный API фичи `bookings`
// (импорт внутреннего файла запрещён `pnpm check:arch`), как в `admin-appointments`.
import { salonDayWindow } from '../bookings/index';
import {
  clientRefundStatus,
  listCompletedRefunds,
  listRefundsNeedingAttention,
  type RefundNeedingAttention,
} from '../payments/index';

/**
 * Админка: обзор возвратов (#298).
 *
 * Правила:
 * - два списка, `scope=attention` (по умолчанию) и `scope=completed`; отбор делает фича
 *   платежей (`listRefundsNeedingAttention` — долг по флагу, `listCompletedRefunds` —
 *   зафиксированный возврат), здесь только контекст записи;
 * - статус возврата — только `clientRefundStatus` (#103): служебные коды `refund_status`
 *   наружу не отдаются, второй словарь не заводим;
 * - период считается по `payments.created_at` (решение владельца), а не по дате записи;
 *   границы — календарные дни в TZ салона: `from` → начало дня, `to` → начало следующего
 *   дня (полуоткрытый интервал, переход на летнее/зимнее время учтён `salonDayWindow`);
 * - порядок и кап задаёт выборка платежей: старые первыми, затем id, не больше 50 строк;
 * - контекст записи дозагружается одним `appointment.findMany` по списку id (без N+1),
 *   почта клиента не читается вовсе.
 *
 * ПДн: имя и полный телефон клиента попадают только в ответ авторизованному сотруднику
 * (как в `GET /admin/appointments`, #242) и никогда — в логи.
 */

/** Параметры обзора: scope и необязательный период в календарных днях TZ салона. */
export interface AdminRefundsQueryInput {
  scope: AdminRefundsScope;
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * Строка записи для DTO возврата: имена мастера и услуги приходят в том же запросе.
 * Ни почты, ни дедлайна оплаты, ни `createdAt` записи: экрану возвратов они не нужны.
 */
interface AdminRefundAppointmentRow {
  id: string;
  startsAt: Date;
  status: BookingStatus;
  cancelReason: string | null;
  clientName: string;
  clientPhone: string;
  master: { fullName: string };
  service: { name: string };
}

const refundAppointmentSelect = {
  id: true,
  startsAt: true,
  status: true,
  cancelReason: true,
  clientName: true,
  clientPhone: true,
  master: { select: { fullName: true } },
  service: { select: { name: true } },
} as const;

/**
 * Границы периода по `payments.created_at`.
 *
 * `from` — начало своего дня, `to` — начало следующего дня за `to`: конец дня `to` входит
 * в период (сотрудник ждёт «до 30 июня включительно»), а стык двух запросов не теряет
 * и не дублирует строку.
 */
function refundPeriod(from?: string, to?: string): { createdFrom?: Date; createdTo?: Date } {
  return {
    ...(from === undefined
      ? {}
      : { createdFrom: salonDayWindow(from, env.SALON_TIMEZONE).startsAt }),
    ...(to === undefined ? {} : { createdTo: salonDayWindow(to, env.SALON_TIMEZONE).endsAt }),
  };
}

/** Строка выборки платежей + запись → строка ответа; `null`, если запись не нашлась. */
function toAdminRefundItem(
  payment: RefundNeedingAttention,
  appointment: AdminRefundAppointmentRow | undefined,
): AdminRefundItem | null {
  // Запись удаляется каскадом вместе с платежом, поэтому её отсутствие — аномалия.
  // Такую строку не показываем: без контекста записи возврат не разобрать.
  if (appointment === undefined) return null;

  const refundStatus = clientRefundStatus(payment);
  // При отборе `attention` (флаг возврата) и `completed` (`status: 'refunded'`) статус есть
  // всегда: `null` здесь означал бы расхождение отбора и словаря — строку не показываем.
  if (refundStatus === null) return null;

  return {
    paymentId: payment.paymentId,
    appointmentId: payment.appointmentId,
    refundStatus,
    amountKopecks: payment.amountKopecks,
    createdAt: payment.createdAt.toISOString(),
    appointment: {
      startsAt: appointment.startsAt.toISOString(),
      status: appointment.status,
      serviceName: appointment.service.name,
      masterName: appointment.master.fullName,
      clientName: appointment.clientName,
      clientPhone: appointment.clientPhone,
      cancelReason: appointment.cancelReason,
    },
  };
}

/** `GET /admin/refunds`: обзор возвратов выбранного списка за период (или за всё время). */
export async function listAdminRefunds(
  db: Db,
  query: AdminRefundsQueryInput,
): Promise<AdminRefundsResponse> {
  const options = refundPeriod(query.from, query.to);
  const payments =
    query.scope === 'completed'
      ? await listCompletedRefunds(db, options)
      : await listRefundsNeedingAttention(db, options);

  // Контекст записи — одним запросом на весь список: платежи ссылаются на записи, поэтому
  // набор id уникален, а порядок строк задаёт выборка платежей.
  const appointmentIds = [...new Set(payments.map((payment) => payment.appointmentId))];
  const appointments =
    appointmentIds.length === 0
      ? []
      : await db.appointment.findMany({
          where: { id: { in: appointmentIds } },
          select: refundAppointmentSelect,
        });
  const appointmentsById = new Map(
    appointments.map((appointment) => [appointment.id, appointment]),
  );

  const items: AdminRefundItem[] = [];
  for (const payment of payments) {
    const item = toAdminRefundItem(payment, appointmentsById.get(payment.appointmentId));
    if (item !== null) items.push(item);
  }

  return { items };
}
