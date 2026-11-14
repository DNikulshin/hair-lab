import type { Booking, BookingStatus, CreateBooking } from '@hair-lab/contracts';
import { maskPhone } from '@hair-lab/contracts';
import { env } from '../../shared/config/env';
import { sqlStateOf, type Db } from '../../shared/db';
import {
  createPaymentHold,
  failPaymentCreation,
  findPaymentByAppointment,
  paymentHoldDeadline,
  savePaymentDetails,
  type PaymentGateway,
} from '../payments/index';
import {
  BOOKING_CONFIRMATION_TYPE,
  buildBookingConfirmationPayload,
} from './booking-confirmation.email';
import { isSlotBookable, loadSchedules, salonDateOf } from './slots.service';

/**
 * Создание записи на услугу.
 *
 * Идемпотентность: клиент присылает `idempotencyKey`, повтор запроса возвращает ту же запись.
 * Непересечение слотов одного мастера держит EXCLUDE-констрейнт в БД (`23P01`), поэтому
 * одновременные запросы на один слот не создают дубль — проигравший получает 409.
 * Телефоны и почта клиента наружу не отдаются и в логи не пишутся: для экрана успеха
 * клиент получает только маску номера (`clientPhoneMasked`).
 *
 * Оплата (`PAYMENTS_MODE != 'off'`, issue #8): запись создаётся как холд на 15 минут —
 * `pending` + `paymentDeadlineAt` + строка `payments(pending)` в той же транзакции, письмо-
 * подтверждение в outbox не пишется (оно уйдёт после оплаты). Платёж в шлюзе создаётся
 * после коммита, вне транзакции; `confirmationUrl` и дедлайн холда возвращаются в `payment`.
 * Без оплаты (по умолчанию) поведение прежнее, ни одного лишнего запроса.
 */

const MINUTE_MS = 60_000;
const CURRENCY = 'RUB' as const;

/** Настройки режима оплаты, которые передаёт `app`: шлюз как зависимость, а не `process.env` в коде. */
export interface CreateBookingPaymentsOptions {
  /** Шлюз платежей: в тестах — поддельный, в проде — клиент ЮKassa. */
  gateway: PaymentGateway;
  /** Куда вернуть клиента после оплаты (`YOOKASSA_RETURN_URL`). */
  returnUrl: string;
}

export interface CreateBookingOptions {
  /** Оплата включена (`PAYMENTS_MODE != 'off'`): запись создаётся вместе с холдом платежа. */
  payments?: CreateBookingPaymentsOptions;
}

/** Сколько раз пробуем записать при транзиентном конфликте: первая попытка и один повтор. */
export const MAX_WRITE_CONFLICT_ATTEMPTS = 2;

/**
 * Транзиентный конфликт записи: serialization failure (`40001`), deadlock (`40P01`) или
 * `P2034` (write conflict/deadlock в терминах Prisma).
 *
 * Это не нарушение бизнес-правил, а проигранная гонка: транзакция откатывается целиком
 * (ни записи, ни строки outbox не остаётся), поэтому попытку можно повторить.
 */
export function isWriteConflict(error: unknown): boolean {
  const sqlState = sqlStateOf(error);
  if (sqlState === '40001' || sqlState === '40P01') return true;
  return (error as { code?: string } | undefined)?.code === 'P2034';
}

/** Выбранное время занято, нерабочее или вне горизонта записи: ответ 409 `slot_unavailable`. */
export class SlotUnavailableError extends Error {
  constructor() {
    super('Выбранное время недоступно');
    this.name = 'SlotUnavailableError';
  }
}

/** Тот же `idempotencyKey`, но другое содержимое запроса: ответ 409 `conflict`. */
export class IdempotencyConflictError extends Error {
  readonly statusCode = 409;

  constructor() {
    super('Ключ идемпотентности уже использован для другого запроса');
    this.name = 'IdempotencyConflictError';
  }
}

/** Запись на несуществующую или отключённую услугу: ответ 404 `not_found`. */
export class ServiceNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super('Услуга не найдена');
    this.name = 'ServiceNotFoundError';
  }
}

/**
 * Мастер не найден, отключён или не оказывает выбранную услугу: ответ 404 `not_found`.
 * Одна ошибка на все три случая: наличие мастера и его связи с услугой не раскрываем,
 * а `GET /slots` такого мастера и так не предлагает.
 */
export class MasterNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super('Мастер не найден');
    this.name = 'MasterNotFoundError';
  }
}

/** Платёж не удалось создать в шлюзе: запись отменена, ответ 502 (см. `bookingRoutes`). */
export class PaymentCreationFailedError extends Error {
  constructor() {
    super('Не удалось создать платёж');
    this.name = 'PaymentCreationFailedError';
  }
}

/** Строка записи, достаточная для DTO (телефон нужен только для маски, почта не нужна). */
interface AppointmentRow {
  id: string;
  masterId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  status: BookingStatus;
  priceKopecks: number;
  durationMin: number;
  clientName: string;
  clientPhone: string;
  /** Дедлайн холда: не `null` только когда оплата ждётся. */
  paymentDeadlineAt: Date | null;
}

export interface CreateBookingResult {
  /** 201 — запись создана, 200 — повтор запроса с тем же ключом идемпотентности. */
  status: 200 | 201;
  booking: Booking;
}

/**
 * Маппинг строки БД в DTO: копейки → money, время → ISO, телефон → маска.
 * Почта не возвращается, телефон — только последние две цифры (ПДн).
 */
function toBookingDto(row: AppointmentRow): Booking {
  return {
    id: row.id,
    masterId: row.masterId,
    serviceId: row.serviceId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    status: row.status,
    price: { amountMinor: row.priceKopecks, currency: CURRENCY },
    durationMin: row.durationMin,
    clientName: row.clientName,
    clientPhoneMasked: maskPhone(row.clientPhone),
  };
}

/**
 * Тот же ли это запрос. Сравниваем только мастера, услугу и начало записи:
 * повтор с исправленными контактами клиента считается тем же запросом.
 */
function isSameRequest(row: AppointmentRow, dto: CreateBooking): boolean {
  return (
    row.masterId === dto.masterId &&
    row.serviceId === dto.serviceId &&
    row.startsAt.getTime() === new Date(dto.startsAt).getTime()
  );
}

/** Повтор ключа: либо та же запись (200), либо конфликт содержимого (409). */
async function reuseOrConflict(
  db: Db,
  row: AppointmentRow,
  dto: CreateBooking,
  payments?: CreateBookingPaymentsOptions,
): Promise<CreateBookingResult> {
  if (!isSameRequest(row, dto)) throw new IdempotencyConflictError();
  return { status: 200, booking: await toBookingDtoWithPayment(db, row, payments) };
}

/**
 * DTO с данными оплаты, если запись всё ещё ждёт её: повтор запроса по `idempotencyKey` и
 * проигранная гонка возвращают ту же ссылку на оплату из БД, не создавая второй платёж
 * и не обращаясь к шлюзу.
 */
async function toBookingDtoWithPayment(
  db: Db,
  row: AppointmentRow,
  payments?: CreateBookingPaymentsOptions,
): Promise<Booking> {
  const booking = toBookingDto(row);
  if (payments === undefined) return booking;

  const payment = await findPaymentByAppointment(db, row.id);
  if (payment === null || payment.status !== 'pending' || payment.confirmationUrl === null) {
    return booking;
  }
  if (row.paymentDeadlineAt === null) return booking;

  return {
    ...booking,
    payment: {
      confirmationUrl: payment.confirmationUrl,
      expiresAt: row.paymentDeadlineAt.toISOString(),
    },
  };
}

/**
 * Создание платежа в шлюзе — после коммита записи, вне транзакции: сетевой вызов не держит
 * транзакцию открытой, а `Idempotence-Key: payment-<appointmentId>` защищает от дубля платежа
 * при ретрае (ЮKassa вернёт тот же платёж).
 *
 * Сбой шлюза не оставляет слот занятым: запись отменяется (`payment_creation_failed`), платёж
 * становится `canceled`, наружу — `PaymentCreationFailedError` (502).
 */
async function createGatewayPayment(
  db: Db,
  payments: CreateBookingPaymentsOptions,
  input: {
    booking: Booking;
    appointmentId: string;
    paymentId: string;
    deadline: Date;
    serviceName: string;
  },
): Promise<Booking> {
  try {
    const created = await payments.gateway.createPayment({
      appointmentId: input.appointmentId,
      amountKopecks: input.booking.price.amountMinor,
      // Описание без ПДн: только услуга. Ни имени, ни телефона, ни почты.
      description: `Оплата записи: ${input.serviceName}`,
      returnUrl: payments.returnUrl,
      idempotenceKey: `payment-${input.appointmentId}`,
    });

    await savePaymentDetails(db, input.paymentId, created);

    return {
      ...input.booking,
      payment: {
        confirmationUrl: created.confirmationUrl,
        // Срок ссылки — дедлайн нашего холда: после него запись снимается свипером.
        expiresAt: input.deadline.toISOString(),
      },
    };
  } catch {
    // Слот не должен остаться занятым неоплаченной записью: компенсация и 502.
    await failPaymentCreation(db, input.appointmentId);
    throw new PaymentCreationFailedError();
  }
}

/**
 * Слот занят — то есть гонку за время приёма мы проиграли. Но занявшим его запросом мог быть
 * наш собственный: клиент повторяет запрос с тем же `idempotencyKey` (сетевой ретрай), и его
 * первая попытка успела зафиксировать запись. Поэтому при занятом слоте сначала смотрим ключ:
 * клиентский ретрай идемпотентен — есть запись с нашим ключом, отдаём её (200) или конфликт
 * содержимого (409 `conflict`); записи нет — время действительно занято (409 `slot_unavailable`).
 *
 * Используется в двух местах: когда слот недоступен по расписанию (`isSlotBookable`)
 * и когда запись проиграла гонку на уровне БД (`23P01`, `23505`, `P2034` после исчерпания попыток).
 */
async function resolveLostRace(
  db: Db,
  dto: CreateBooking,
  payments?: CreateBookingPaymentsOptions,
): Promise<CreateBookingResult> {
  const repeated = await db.appointment.findUnique({
    where: { idempotencyKey: dto.idempotencyKey },
  });
  if (repeated !== null) return reuseOrConflict(db, repeated, dto, payments);
  throw new SlotUnavailableError();
}

/**
 * `POST /bookings`: проверка услуги и мастера, проверка доступности, создание записи,
 * снимки цены и длительности услуги. Неактивная услуга и мастер, который её не оказывает
 * (в том числе неизвестный или отключённый), отсекаются до загрузки расписания — 404.
 * Доступность проверяется той же логикой, что и `GET /slots`, но окончательную гарантию
 * от гонки даёт EXCLUDE-констрейнт (см. обработку `23P01`).
 *
 * Транзиентный конфликт записи (`P2034`, `40001`, `40P01`) — тоже проигранная гонка,
 * а не ошибка сервера: попытка (перечитать расписание → проверить доступность → записать)
 * повторяется `MAX_WRITE_CONFLICT_ATTEMPTS` раз и лишь затем разбирается как 409.
 * Занятый на попытке слот тоже сначала сверяется с `idempotencyKey`: запись с нашим ключом
 * отдаётся как повтор (200), а не превращается в 409 `slot_unavailable`.
 *
 * `clientId` передаёт маршрут, когда запрос пришёл с сессией клиента; гостевые записи
 * остаются без аккаунта. Контракты запроса и ответа не меняются: клиент не может указать
 * чужой аккаунт.
 *
 * `options.payments` включает режим оплаты: шлюз и адрес возврата приходят из `app`
 * (в тестах — поддельный шлюз), чтения `process.env` внутри сервиса нет.
 */
export async function createBooking(
  db: Db,
  dto: CreateBooking,
  clientId?: string,
  options: CreateBookingOptions = {},
): Promise<CreateBookingResult> {
  const tz = env.SALON_TIMEZONE;
  const payments = options.payments;

  const existing = await db.appointment.findUnique({
    where: { idempotencyKey: dto.idempotencyKey },
  });
  if (existing !== null) return reuseOrConflict(db, existing, dto, payments);

  const service = await db.service.findFirst({
    where: { id: dto.serviceId, isActive: true },
    select: { id: true, name: true, durationMin: true, priceKopecks: true },
  });
  if (service === null) throw new ServiceNotFoundError();

  // Мастер, его активность и связь с услугой — одним запросом: без N+1 и без FK-нарушения
  // на `appointment.master_id`. Неизвестный, отключённый мастер и мастер без услуги
  // дают одинаковый 404: `GET /slots` таких мастеров не предлагает.
  const master = await db.master.findFirst({
    where: { id: dto.masterId, isActive: true, services: { some: { serviceId: service.id } } },
    select: { id: true, fullName: true },
  });
  if (master === null) throw new MasterNotFoundError();

  const startsAt = new Date(dto.startsAt);
  const endsAt = new Date(startsAt.getTime() + service.durationMin * MINUTE_MS);
  const date = salonDateOf(startsAt, tz);

  // Повтор безопасен по двум причинам: при конфликте транзакция откатывается целиком
  // (ни записи, ни строки outbox не остаётся), а `idempotencyKey` не даёт создать дубль —
  // если первая попытка всё-таки зафиксировалась, повтор вернёт ту же запись (200).
  for (let attempt = 1; ; attempt += 1) {
    // Расписание перечитываем на каждой попытке: за время конфликта мог победить
    // параллельный запрос, и проверять доступность по устаревшему снимку бессмысленно.
    const schedules = await loadSchedules(db, [dto.masterId], date, tz);
    const schedule = schedules.get(dto.masterId) ?? {
      workingHours: [],
      exceptions: [],
      appointments: [],
    };

    if (!isSlotBookable({ ...schedule, date, tz, startsAt, endsAt })) {
      // На повторе после конфликта записи занятый слот может быть нашей же записью:
      // ключ проверяем до 409 `slot_unavailable`, иначе сетевой ретрай клиента ломается.
      return await resolveLostRace(db, dto, payments);
    }

    try {
      // Запись и письмо в очередь — одной транзакцией (transactional outbox):
      // нет строки outbox без записи и наоборот. Отправкой занимается фоновый диспетчер,
      // поэтому недоступный SMTP не ломает создание записи (AGENTS.md, «Данные и надёжность»).
      //
      // В режиме оплаты вместо письма в той же транзакции пишется строка платежа-холда:
      // письмо-подтверждение уйдёт только после успешной оплаты (обработчик уведомления).
      const deadline = payments === undefined ? null : paymentHoldDeadline();

      const created = await db.$transaction(async (tx) => {
        const appointment = await tx.appointment.create({
          data: {
            masterId: dto.masterId,
            serviceId: service.id,
            clientName: dto.clientName,
            clientPhone: dto.clientPhone,
            ...(dto.clientEmail === undefined ? {} : { clientEmail: dto.clientEmail }),
            clientId: clientId ?? null,
            startsAt,
            endsAt,
            priceKopecks: service.priceKopecks,
            durationMin: service.durationMin,
            idempotencyKey: dto.idempotencyKey,
            // Дедлайн холда: до него запись ждёт оплаты, после — снимается свипером.
            ...(deadline === null ? {} : { paymentDeadlineAt: deadline }),
          },
        });

        if (deadline !== null) {
          const hold = await createPaymentHold(tx, {
            appointmentId: appointment.id,
            amountKopecks: service.priceKopecks,
          });
          return { appointment, paymentId: hold.paymentId };
        }

        // Письмо нужно только когда клиент оставил почту. Снимок собирается одной точкой
        // (`buildBookingConfirmationPayload`): правка услуги или мастера позже не меняет
        // уже созданное письмо.
        if (dto.clientEmail !== undefined) {
          await tx.outboxMessage.create({
            data: {
              type: BOOKING_CONFIRMATION_TYPE,
              appointmentId: appointment.id,
              payload: buildBookingConfirmationPayload({
                clientName: dto.clientName,
                clientEmail: dto.clientEmail,
                serviceName: service.name,
                masterName: master.fullName,
                startsAt,
                endsAt,
                priceKopecks: service.priceKopecks,
                durationMin: service.durationMin,
              }),
            },
          });
        }

        return { appointment, paymentId: null };
      });

      const booking = toBookingDto(created.appointment);
      if (payments === undefined || created.paymentId === null || deadline === null) {
        return { status: 201, booking };
      }

      // Платёж в шлюзе — после коммита: сетевой вызов не держит транзакцию открытой.
      return {
        status: 201,
        booking: await createGatewayPayment(db, payments, {
          booking,
          appointmentId: created.appointment.id,
          paymentId: created.paymentId,
          deadline,
          serviceName: service.name,
        }),
      };
    } catch (error) {
      const writeConflict = isWriteConflict(error);
      // Транзиентный конфликт — повторяем попытку с начала (свежая проверка доступности).
      if (writeConflict && attempt < MAX_WRITE_CONFLICT_ATTEMPTS) continue;

      const sqlState = sqlStateOf(error);
      // 23P01 — слот занял параллельный запрос, 23505 — уникальность idempotency_key,
      // write conflict после исчерпания попыток — та же проигранная гонка.
      // Во всех случаях повторяем чтение по ключу: если запись есть, повтор безопасен.
      if (!writeConflict && sqlState !== '23P01' && sqlState !== '23505') throw error;

      return await resolveLostRace(db, dto, payments);
    }
  }
}
