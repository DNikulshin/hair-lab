import type { FastifyRequest } from 'fastify';
import type { Prisma } from '../../generated/prisma/client';
import type { Db } from '../../shared/db';

/**
 * Анти-абьюз онлайн-записи (issue #106): лимиты на `POST /bookings`.
 *
 * Два независимых предохранителя, оба про «много записей с одного источника»:
 * - по адресу клиента (per-route rate limit `@fastify/rate-limit`, см. `createBookingsIpRateLimit`);
 * - по телефону: не больше трёх активных будущих записей и не больше двух одновременно
 *   ожидающих оплаты холдов (`assertPhoneBookingLimits`, счёт в транзакции записи).
 *
 * Телефон — персональные данные: он приходит bind-параметром запроса и не выводится ни в ответ,
 * ни в заголовки, ни в логи этой фичи (в логе маршрута — только маска).
 */

/**
 * IP-лимит: 10 созданий записи за 10 минут с одного адреса (решение владельца, #106).
 * С запасом покрывает реальный сценарий «записался сам и записал семью» и отсекает скрипт,
 * который холдирует слоты пачкой.
 */
export const BOOKINGS_IP_MAX = 10;
/** Окно IP-лимита: счётчик в памяти процесса, окно скользящее по ключу (store пакета). */
export const BOOKINGS_IP_WINDOW = '10 minutes';

/**
 * Сколько активных будущих записей может держать один телефон: `pending` и `confirmed`
 * с началом в будущем. Отменённая, прошедшая, `completed` и `no_show` запись место освобождает —
 * иначе аккуратный клиент упирался бы в лимит историей визитов.
 */
export const MAX_ACTIVE_BOOKINGS_PER_PHONE = 3;

/**
 * Сколько холдов «жду оплату» может висеть на одном телефоне: `pending` с дедлайном в будущем.
 * Число меньше общего лимита: неоплаченный холд держит слот, а оплаченная запись — это уже
 * состоявшийся визит. Истёкший дедлайн ожиданием не считается (свипер снимет холд по `lte: now`).
 */
export const MAX_PENDING_HOLDS_PER_PHONE = 2;

/** Какая именно ветка лимита сработала: в лог пишем причину, наружу — общий 429. */
export type BookingLimitReason = 'active_bookings' | 'pending_holds';

/** Телефон превысил лимит записей: ответ 429 `rate_limited` (см. `bookingRoutes`). */
export class BookingLimitError extends Error {
  /** Причина отказа: две ветки лимита различаются только в логе, код ответа общий. */
  readonly reason: BookingLimitReason;

  constructor(reason: BookingLimitReason) {
    super('Лимит записей для этого телефона исчерпан');
    this.name = 'BookingLimitError';
    this.reason = reason;
  }
}

/**
 * Взять транзакционный advisory-лок по телефону в текущей транзакции.
 *
 * Параллельные запросы одного телефона выстраиваются в очередь этим локом
 * (`pg_advisory_xact_lock`): без него обе транзакции прочитали бы `count = 2` на готовом
 * уровне `pg_read_committed` и создали бы четвёртую запись. Лок снимается коммитом или
 * откатом, вручную освобождать нечего.
 *
 * Функция экспортируется отдельно, потому что сервису нужно взять лок **раньше** лимитов:
 * после лока (`createBooking`) он перечитывает `idempotencyKey` и отдаёт повтор, не считая
 * лимиты. Повторный вызов в той же транзакции — no-op: advisory-лок реентерабелен
 * (повторный захват тем же бэкендом не блокирует), поэтому `assertPhoneBookingLimits`
 * продолжает брать лок сама и остаётся корректной при одиночном вызове.
 *
 * Телефон передаётся bind-параметром: в тексте запроса его нет. `hashtextextended(phone, 0)` —
 * 64-битный ключ лока (тем же значением лочатся параллельные запросы с тем же номером).
 *
 * `pg_advisory_xact_lock` возвращает `void`, а клиент Prisma 7 не разбирает такую колонку
 * (`UnsupportedNativeDataType`), поэтому функция обёрнута в подзапрос и наружу отдаётся
 * только `count(*)`: лок всё равно остаётся транзакционным.
 */
export async function lockPhoneBookings(
  tx: Prisma.TransactionClient,
  clientPhone: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT count(*)::int AS locked
    FROM (SELECT pg_advisory_xact_lock(hashtextextended(${clientPhone}, 0))) AS held
  `;
}

/**
 * Лимиты телефона внутри транзакции создания записи (`createBooking`).
 *
 * Счёт идёт по фактическим строкам БД, а не инкрементом счётчика: откат транзакции
 * (конфликт слота, `idempotency_key`) не оставляет дрейфа, а лимит всегда соответствует
 * тому, что видно в базе.
 *
 * Контракт по локу: функция сама берёт advisory-лок по телефону (`lockPhoneBookings`) до
 * счёта, поэтому её можно вызывать как единственную точку проверки. Если лок уже взят выше
 * в этой же транзакции (так делает `createBooking`, чтобы успеть перечитать `idempotencyKey`),
 * повторный захват — no-op и лишней блокировки не даёт.
 */
export async function assertPhoneBookingLimits(
  tx: Prisma.TransactionClient,
  clientPhone: string,
  now: Date = new Date(),
): Promise<void> {
  await lockPhoneBookings(tx, clientPhone);

  const activeBookings = await tx.appointment.count({
    where: {
      clientPhone,
      startsAt: { gt: now },
      status: { in: ['pending', 'confirmed'] },
    },
  });
  if (activeBookings >= MAX_ACTIVE_BOOKINGS_PER_PHONE)
    throw new BookingLimitError('active_bookings');

  // Предикат зеркален выборке свипера (`status = pending AND payment_deadline_at <= now`):
  // холд, у которого дедлайн уже прошёл, ожиданием оплаты не считается.
  const pendingHolds = await tx.appointment.count({
    where: { clientPhone, status: 'pending', paymentDeadlineAt: { gt: now } },
  });
  if (pendingHolds >= MAX_PENDING_HOLDS_PER_PHONE) throw new BookingLimitError('pending_holds');
}

/**
 * Per-route конфиг лимита `POST /bookings` для `@fastify/rate-limit@11`.
 *
 * `allowList` в v11 — функция `(req) => boolean`: при `true` пакет возвращает `isAllowed`
 * и **не** трогает счётчик, поэтому повтор по `idempotencyKey` не расходует IP-бюджет
 * (иначе сетевой ретрай упирался бы в 429, хотя запись уже создана).
 * `hook: 'preHandler'` — к моменту вызова тело уже разобрано и провалидировано Zod-схемой,
 * то есть `idempotencyKey` можно читать безопасно; невалидное тело до хука не доходит,
 * но защита от не-объекта всё равно нужна (тесты и будущие вызовы).
 */
export interface BookingsIpRateLimit {
  max: number;
  timeWindow: string;
  hook: 'preHandler';
  allowList: (request: FastifyRequest) => Promise<boolean>;
}

/** Ключ идемпотентности из тела: только непустая строка, иначе лимит применяется как обычно. */
function idempotencyKeyOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const key = (body as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/** Запрос повторяет уже созданную запись — лимитом не считается (кроме 409 `conflict`). */
async function isIdempotencyReplay(db: Db, body: unknown): Promise<boolean> {
  const idempotencyKey = idempotencyKeyOf(body);
  if (idempotencyKey === null) return false;
  const repeated = await db.appointment.findUnique({
    where: { idempotencyKey },
    select: { id: true },
  });
  return repeated !== null;
}

/**
 * Фабрика лимита: маршрут передаёт конфиг в `config.rateLimit`, а `db` нужен, чтобы до счётчика
 * проверить, не является ли запрос повтором по ключу идемпотентности. Ключ лимита — адрес
 * клиента (дефолтный `keyGenerator` пакета = `req.ip`, доверие X-Forwarded-For уже включено
 * в `buildServer`).
 */
export function createBookingsIpRateLimit(db: Db): BookingsIpRateLimit {
  return {
    max: BOOKINGS_IP_MAX,
    timeWindow: BOOKINGS_IP_WINDOW,
    hook: 'preHandler',
    allowList: (request) => isIdempotencyReplay(db, request.body),
  };
}
