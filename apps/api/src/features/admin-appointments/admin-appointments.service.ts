import type {
  AdminAppointment,
  AdminAppointmentsResponse,
  BookingStatus,
} from '@hair-lab/contracts';
import { env } from '../../shared/config/env';
import type { Db } from '../../shared/db';
// Границы дня и типы писем — через публичный API фичи `bookings`: импорт внутреннего файла
// (`slots.service`) запрещён `pnpm check:arch`, поэтому путь указан на её `index.ts`.
import {
  BOOKING_CANCELLATION_TYPE,
  BOOKING_CONFIRMATION_TYPE,
  salonDayWindow,
} from '../bookings/index';

/**
 * Админка: записи на день и переходы статусов (#242).
 *
 * Правила:
 * - список — записи, чьё начало попадает в календарный день в TZ салона; границы дня считает
 *   `salonDayWindow` (переход на летнее/зимнее время учтён), сортировка — `startsAt ASC, id ASC`;
 * - переходы: `pending → confirmed`, `pending|confirmed → cancelled`, `pending|confirmed →
 *   completed`, `pending|confirmed → no_show`. Финальные статусы (`cancelled`, `completed`,
 *   `no_show`) повторно не меняются — 409 `conflict`;
 * - повтор уже выполненного действия идемпотентен: 200, запись не переписывается (в том числе
 *   `updatedAt`) и писем не ставит;
 * - причина салонной отмены пишется в `cancel_reason` как `cancelled_by_salon: <причина>`:
 *   по конвенции клиентской отмены (`cancelled_by_client`) видно, кто отменил. Повтор
 *   салонной отмены идемпотентен; если запись отменил клиент (или её сняла оплата),
 *   это 409 — чужую причину не перезаписываем;
 * - отмена и письма — одной транзакцией (outbox): `pending`-подтверждение становится
 *   `suppressed`, письмо `booking_cancellation` ставится только при непустой почте клиента.
 *   Сбой отправки письма отмену не ломает — письмо отправит фоновый диспетчер.
 *
 * Условие перехода стоит в самом `UPDATE ... WHERE status IN (...)`: гонка невозможна,
 * проигравший запрос видит актуальное состояние и классифицируется перечитыванием (404/409).
 *
 * ПДн: телефоны и почта читаются только для DTO и письма. В логах (см. routes) телефона
 * нет — только маска; имя и почта клиента не логируются вовсе.
 */

/** Префикс причины салонной отмены в `appointments.cancel_reason`. */
export const SALON_CANCEL_REASON_PREFIX = 'cancelled_by_salon';

/**
 * Код причины в `outbox_messages.last_error` для подавленного подтверждения.
 * Тот же, что у клиентской отмены: диспетчеру он безразличен, а значение короткое и без ПДн.
 */
const CANCELLATION_SUPPRESS_REASON = 'cancelled';

/** Статусы, из которых запись ещё «живая»: только их можно перевести в другой статус. */
const ACTIVE_STATUSES: BookingStatus[] = ['pending', 'confirmed'];

/** Записи нет: ответ 404 `not_found`. */
export class AdminAppointmentNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super('Запись не найдена');
    this.name = 'AdminAppointmentNotFoundError';
  }
}

/** Переход недопустим из текущего статуса: ответ 409 `conflict`. */
export class AdminAppointmentConflictError extends Error {
  readonly statusCode = 409;

  constructor() {
    super('Недопустимое состояние записи');
    this.name = 'AdminAppointmentConflictError';
  }
}

/** Строка записи, достаточная для DTO: только нужные поля и имена через relation. */
interface AdminAppointmentRow {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: BookingStatus;
  priceKopecks: number;
  durationMin: number;
  clientName: string;
  clientPhone: string;
  master: { fullName: string };
  service: { name: string };
}

/**
 * Выборка для DTO: имена мастера и услуги приходят в том же запросе (`select` с relation),
 * без N+1. Почта и причина отмены не читаются — для ответа они не нужны.
 */
const adminAppointmentSelect = {
  id: true,
  startsAt: true,
  endsAt: true,
  status: true,
  priceKopecks: true,
  durationMin: true,
  clientName: true,
  clientPhone: true,
  master: { select: { fullName: true } },
  service: { select: { name: true } },
} as const;

/** Классификация отказа: те же поля плюс причина, чтобы отличить нашу отмену от клиентской. */
const classifiedSelect = { ...adminAppointmentSelect, cancelReason: true } as const;

/** Снимок отмены для письма: те же поля плюс почта клиента. */
const cancellationSnapshotSelect = { ...adminAppointmentSelect, clientEmail: true } as const;

/** Строка БД → DTO админки: время → ISO, имена через relation, телефон без маски. */
function toAdminAppointment(row: AdminAppointmentRow): AdminAppointment {
  return {
    id: row.id,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    priceKopecks: row.priceKopecks,
    durationMin: row.durationMin,
    serviceName: row.service.name,
    masterName: row.master.fullName,
    clientName: row.clientName,
    clientPhone: row.clientPhone,
  };
}

/** Причина салонной отмены в том виде, в каком она лежит в БД. */
export function salonCancelReason(reason: string): string {
  return `${SALON_CANCEL_REASON_PREFIX}: ${reason}`;
}

/** Отменил ли запись салон этим маршрутом: только тогда повтор отмены идемпотентен. */
function isSalonCancellation(cancelReason: string | null): boolean {
  return cancelReason !== null && cancelReason.startsWith(`${SALON_CANCEL_REASON_PREFIX}: `);
}

/**
 * `GET /admin/appointments`: записи одного календарного дня в TZ салона.
 * Порядок — по началу приёма, затем по id: одинаковое время не даёт плавающего порядка.
 */
export async function listAdminAppointments(
  db: Db,
  date: string,
): Promise<AdminAppointmentsResponse> {
  const day = salonDayWindow(date, env.SALON_TIMEZONE);

  const rows = await db.appointment.findMany({
    where: { startsAt: { gte: day.startsAt, lt: day.endsAt } },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    select: adminAppointmentSelect,
  });

  return { items: rows.map(toAdminAppointment) };
}

/**
 * Общий переход статуса: один условный `updateMany` в транзакции и классификация отказа
 * перечитыванием. Успешный переход возвращает снимок записи; повтор (целевой статус уже
 * стоит) — снимок без изменений; отсутствие записи — 404; любой другой статус — 409.
 *
 * `cancelReason` задан только для отмены: тогда же снимается `pending`-подтверждение
 * и ставится письмо об отмене (та же транзакция).
 */
async function transition(
  db: Db,
  id: string,
  target: BookingStatus,
  allowedFrom: readonly BookingStatus[],
  cancelReason?: string,
): Promise<AdminAppointment> {
  return db.$transaction(async (tx) => {
    const updated = await tx.appointment.updateMany({
      where: { id, status: { in: [...allowedFrom] } },
      data: cancelReason === undefined ? { status: target } : { status: target, cancelReason },
    });

    if (updated.count === 1) {
      // Отмена: письмо ставится по снимку, прочитанному после UPDATE в этой же транзакции.
      if (target === 'cancelled') {
        const snapshot = await tx.appointment.findFirstOrThrow({
          where: { id },
          select: cancellationSnapshotSelect,
        });

        // Подтверждение уже неуместно: `pending` → `suppressed`. Отправленное не трогаем.
        await tx.outboxMessage.updateMany({
          where: { appointmentId: id, type: BOOKING_CONFIRMATION_TYPE, status: 'pending' },
          data: { status: 'suppressed', lastError: CANCELLATION_SUPPRESS_REASON },
        });

        // Без почты клиента письмо ставить некуда: отмена всё равно состоялась.
        const clientEmail = snapshot.clientEmail?.trim() ?? '';
        if (clientEmail !== '') {
          await tx.outboxMessage.create({
            data: {
              type: BOOKING_CANCELLATION_TYPE,
              appointmentId: id,
              payload: {
                clientName: snapshot.clientName,
                clientEmail,
                serviceName: snapshot.service.name,
                masterName: snapshot.master.fullName,
                startsAt: snapshot.startsAt.toISOString(),
                endsAt: snapshot.endsAt.toISOString(),
                priceKopecks: snapshot.priceKopecks,
                durationMin: snapshot.durationMin,
              },
            },
          });
        }

        return toAdminAppointment(snapshot);
      }

      const snapshot = await tx.appointment.findFirstOrThrow({
        where: { id },
        select: adminAppointmentSelect,
      });
      return toAdminAppointment(snapshot);
    }

    // Строка не обновилась: объясняем причину по актуальному состоянию записи.
    const existing = await tx.appointment.findFirst({
      where: { id },
      select: classifiedSelect,
    });

    if (existing === null) throw new AdminAppointmentNotFoundError();

    // Действие уже выполнено — повтор идемпотентен. У отмены дополнительно проверяем,
    // что отменил именно салон: клиентскую причину не перезаписываем и не выдаём за нашу.
    const alreadyDone =
      existing.status === target &&
      (target !== 'cancelled' || isSalonCancellation(existing.cancelReason));
    if (alreadyDone) return toAdminAppointment(existing);

    throw new AdminAppointmentConflictError();
  });
}

/** `POST /admin/appointments/:id/confirm`: `pending → confirmed`. */
export function confirmAdminAppointment(db: Db, id: string): Promise<AdminAppointment> {
  return transition(db, id, 'confirmed', ['pending']);
}

/** `POST /admin/appointments/:id/cancel`: `pending|confirmed → cancelled` с причиной салона. */
export function cancelAdminAppointment(
  db: Db,
  id: string,
  reason: string,
): Promise<AdminAppointment> {
  return transition(db, id, 'cancelled', ACTIVE_STATUSES, salonCancelReason(reason));
}

/** `POST /admin/appointments/:id/complete`: визит состоялся. */
export function completeAdminAppointment(db: Db, id: string): Promise<AdminAppointment> {
  return transition(db, id, 'completed', ACTIVE_STATUSES);
}

/** `POST /admin/appointments/:id/no-show`: клиент не пришёл. */
export function markAdminAppointmentNoShow(db: Db, id: string): Promise<AdminAppointment> {
  return transition(db, id, 'no_show', ACTIVE_STATUSES);
}
