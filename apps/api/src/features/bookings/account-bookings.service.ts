import type {
  AccountBooking,
  AccountBookingsQuery,
  AccountBookingsResponse,
  BookingStatus,
} from '@hair-lab/contracts';
import { idSchema, isoDateTimeSchema, maskPhone } from '@hair-lab/contracts';
import type { Db } from '../../shared/db';
import { BOOKING_CANCELLATION_TYPE } from './booking-cancellation.email';
import { BOOKING_CONFIRMATION_TYPE } from './booking-confirmation.email';

/**
 * Кабинет клиента: свои записи и отмена по правилам салона.
 *
 * Правила (согласованы в issue #7):
 * - клиент видит только записи со своим `client_id`; гостевые (`client_id IS NULL`) и чужие
 *   записи не попадают в выборку вообще, а не отфильтровываются после чтения;
 * - «предстоящие» — активные записи (`pending`, `confirmed`) с началом не раньше текущего
 *   момента, «прошлые» — всё остальное: прошедшие по времени, отменённые, завершённые, неявки;
 * - отменить можно активную запись, до начала которой осталось не меньше `CANCEL_MIN_LEAD_MS`
 *   (два часа); иначе — 409 `conflict`. Повторная отмена уже отменённой идемпотентна (200);
 * - чужая и несуществующая запись неразличимы: обе дают 404 (наличие чужих записей не раскрываем);
 * - причина отмены ставится сервером (`CANCEL_REASON`), клиент её не присылает.
 *
 * Условия отмены проверяются одним `UPDATE ... WHERE`: гонка между проверкой и записью
 * невозможна, проигравший запрос видит уже актуальное состояние строки.
 *
 * ПДн: телефон клиента в DTO не выходит — только маска; почта читается только при состоявшейся
 * отмене и только для письма (в DTO и в списках её нет).
 */

/** Дедлайн отмены: не позже чем за два часа до начала приёма. */
export const CANCEL_MIN_LEAD_MS = 2 * 60 * 60_000;

/** Причина отмены, которую ставит сервер: клиент её не присылает. */
export const CANCEL_REASON = 'cancelled_by_client';

/**
 * Код причины в `outbox_messages.last_error` для подавлённого подтверждения.
 * Короткий код без содержимого письма и без ПДн: значение видно в БД и админ-инструментах.
 */
const CANCELLATION_SUPPRESS_REASON = 'cancelled';

/** Статусы, в которых запись ещё «живая»: её можно ждать и (по сроку) отменить. */
const ACTIVE_STATUSES: BookingStatus[] = ['pending', 'confirmed'];

/** Запись не найдена или принадлежит другому клиенту: ответ 404 `not_found`. */
export class AccountBookingNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super('Запись не найдена');
    this.name = 'AccountBookingNotFoundError';
  }
}

/** Отмена по правилам салона невозможна (срок, прошедшее время, финальный статус): 409. */
export class BookingNotCancellableError extends Error {
  readonly statusCode = 409;

  constructor() {
    super('Запись нельзя отменить');
    this.name = 'BookingNotCancellableError';
  }
}

/** Курсор пагинации не разбирается: ответ 400 `validation_error`, а не 500. */
export class InvalidCursorError extends Error {
  readonly statusCode = 400;

  constructor() {
    super('Некорректный курсор пагинации');
    this.name = 'InvalidCursorError';
  }
}

/** Строка записи, достаточная для DTO: только нужные поля и имена через relation. */
interface AccountBookingRow {
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
 * без N+1. Телефон нужен только для маски, почта не читается.
 */
const accountBookingSelect = {
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

/**
 * Выборка для состоявшейся отмены: те же поля, что в DTO, плюс почта — она нужна только
 * письму об отмене. Для классификации 404/200/409 почта не читается (см. `accountBookingSelect`).
 */
const cancelledBookingSelect = {
  ...accountBookingSelect,
  clientEmail: true,
} as const;

/** Активная запись с достаточным запасом времени: её можно отменить. */
function isCancellable(row: AccountBookingRow, now: Date): boolean {
  const active = ACTIVE_STATUSES.includes(row.status);
  return active && row.startsAt.getTime() >= now.getTime() + CANCEL_MIN_LEAD_MS;
}

/**
 * Строка БД → DTO кабинета: копейки → money, время → ISO, телефон → маска,
 * `cancellable` считает сервер по текущему моменту.
 */
function toAccountBookingDto(row: AccountBookingRow, now: Date): AccountBooking {
  return {
    id: row.id,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    price: { amountMinor: row.priceKopecks, currency: 'RUB' },
    durationMin: row.durationMin,
    serviceName: row.service.name,
    masterName: row.master.fullName,
    clientName: row.clientName,
    clientPhoneMasked: maskPhone(row.clientPhone),
    cancellable: isCancellable(row, now),
  };
}

/** Позиция в списке: момент начала записи и id как tie-breaker для стабильного порядка. */
interface BookingCursor {
  startsAt: Date;
  id: string;
}

/** Курсор — `${startsAt ISO}|${id}`: читаемый, без base64 и без состояния на сервере. */
function encodeCursor(row: { startsAt: Date; id: string }): string {
  return `${row.startsAt.toISOString()}|${row.id}`;
}

/**
 * Разбор курсора. Битый курсор — 400, а не молчаливая первая страница и не 500:
 * клиент должен узнать, что его ссылка/состояние сломались.
 */
function decodeCursor(raw: string): BookingCursor {
  const separator = raw.indexOf('|');
  if (separator === -1) throw new InvalidCursorError();

  const startsAt = isoDateTimeSchema.safeParse(raw.slice(0, separator));
  const id = idSchema.safeParse(raw.slice(separator + 1));
  if (!startsAt.success || !id.success) throw new InvalidCursorError();

  return { startsAt: new Date(startsAt.data), id: id.data };
}

/**
 * `GET /account/bookings`: страница записей клиента в выбранном `scope`.
 *
 * Сортировка и курсор согласованы: `upcoming` идёт по возрастанию начала (`startsAt ASC, id ASC`),
 * `past` — по убыванию (`startsAt DESC, id DESC`). `nextCursor = null` означает «дальше пусто».
 * `limit + 1` строк читается только чтобы понять, есть ли следующая страница.
 */
export async function listAccountBookings(
  db: Db,
  clientId: string,
  query: AccountBookingsQuery,
  now: Date = new Date(),
): Promise<AccountBookingsResponse> {
  const upcoming = query.scope === 'upcoming';
  const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);

  const scopeWhere = upcoming
    ? { status: { in: ACTIVE_STATUSES }, startsAt: { gte: now } }
    : { OR: [{ status: { notIn: ACTIVE_STATUSES } }, { startsAt: { lt: now } }] };

  const afterCursor =
    cursor === null
      ? null
      : upcoming
        ? {
            OR: [
              { startsAt: { gt: cursor.startsAt } },
              { startsAt: cursor.startsAt, id: { gt: cursor.id } },
            ],
          }
        : {
            OR: [
              { startsAt: { lt: cursor.startsAt } },
              { startsAt: cursor.startsAt, id: { lt: cursor.id } },
            ],
          };

  const rows = await db.appointment.findMany({
    // Условия склеиваются через `AND`, а не спредом: у `scope=past` и у условия курсора
    // есть ключ `OR`, и спред по одному и тому же ключу молча затирал бы фильтр области —
    // вторая страница «прошлых» возвращала бы предстоящие активные записи.
    where: { clientId, AND: [scopeWhere, ...(afterCursor === null ? [] : [afterCursor])] },
    orderBy: upcoming
      ? [{ startsAt: 'asc' }, { id: 'asc' }]
      : [{ startsAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    select: accountBookingSelect,
  });

  const page = rows.slice(0, query.limit);
  const last = page.at(-1);

  return {
    items: page.map((row) => toAccountBookingDto(row, now)),
    nextCursor: rows.length > query.limit && last !== undefined ? encodeCursor(last) : null,
  };
}

/**
 * `DELETE /account/bookings/:id`: отмена своей записи по правилам салона.
 *
 * Отмена — один `updateMany` с условиями `id ∧ clientId ∧ статус активный ∧ срок не вышел`:
 * владелец проверяется в самом `WHERE` (до чтения), поэтому гонка «проверили → отменили»
 * невозможна, а чужая запись не может быть изменена даже теоретически.
 *
 * Отмена и письма — одной транзакцией. Если `updateMany` обновил строку (`count === 1`),
 * то `pending`-подтверждение становится `suppressed` (диспетчер берёт только `pending`),
 * а при непустой почте клиента ставится письмо `booking_cancellation` со снимком записи на
 * момент отмены. Идемпотентность даёт тот же условный `updateMany`: повторная отмена видит,
 * что строка уже не активна, обновить её не может и писем не ставит.
 *
 * Если ни одна строка не обновилась, перечитываем запись по `id`, чтобы объяснить причину:
 * нет записи или другой владелец → 404 (наличие чужих записей не раскрываем);
 * уже `cancelled` → 200 идемпотентно, без перезаписи `cancelReason` и `updatedAt`;
 * иначе (срок вышел, прошедшая, `completed`, `no_show`) → 409 `conflict`.
 * В этих случаях outbox не трогаем вовсе.
 *
 * Известное ограничение (принято, отдельного локинга нет): если фоновый диспетчер уже забрал
 * `pending`-подтверждение в текущем тике (окно ~10 с, `TICK_INTERVAL_MS`), письмо «запись создана»
 * может уйти после отмены: `claim` и `markSent` работают по `id` без проверки статуса.
 * Один экземпляр API и интервал тика делают окно коротким; блокировка строки outbox ради этого
 * не вводится (AGENTS.md, допущения о развёртывании).
 */
export async function cancelAccountBooking(
  db: Db,
  clientId: string,
  id: string,
  now: Date = new Date(),
): Promise<AccountBooking> {
  const row = await db.$transaction(async (tx) => {
    const updated = await tx.appointment.updateMany({
      where: {
        id,
        clientId,
        status: { in: ACTIVE_STATUSES },
        startsAt: { gte: new Date(now.getTime() + CANCEL_MIN_LEAD_MS) },
      },
      data: { status: 'cancelled', cancelReason: CANCEL_REASON },
    });

    if (updated.count === 1) {
      // Отмена состоялась: читаем снимок для письма (включая почту) — запись уже cancelled,
      // поэтому повторный запрос в эту ветку не попадёт и дубля письма не будет.
      const snapshot = await tx.appointment.findFirstOrThrow({
        where: { id, clientId },
        select: cancelledBookingSelect,
      });

      // Подтверждение уже неуместно: `pending` → `suppressed` с коротким кодом причины.
      // Прочие статусы (sent, failed) не трогаем: письмо либо уже ушло, либо не уйдёт.
      await tx.outboxMessage.updateMany({
        where: { appointmentId: id, type: BOOKING_CONFIRMATION_TYPE, status: 'pending' },
        data: { status: 'suppressed', lastError: CANCELLATION_SUPPRESS_REASON },
      });

      // Без почты клиента письмо поставить некуда: подтверждение всё равно снято.
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

      return snapshot;
    }

    // Строка не обновилась: перечитываем только поля DTO (почта тут не нужна) и объясняем причину.
    const existing = await tx.appointment.findFirst({
      where: { id, clientId },
      select: accountBookingSelect,
    });

    // Собственную запись не нашли: её нет или она принадлежит другому клиенту.
    if (existing === null) throw new AccountBookingNotFoundError();

    if (existing.status !== 'cancelled') throw new BookingNotCancellableError();

    return existing;
  });

  return toAccountBookingDto(row, now);
}
