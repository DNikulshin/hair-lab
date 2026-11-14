import {
  bookingPaymentSchema,
  idSchema,
  type Booking,
  type BookingPayment,
} from '@hair-lab/contracts';

/**
 * Черновик оплаты: как страница `/booking/payment` узнаёт, о какой записи речь.
 *
 * `return_url` ЮKassa статичен (`${APP_URL}/booking/payment`, без id — см. `apps/api`), поэтому
 * после возврата с платёжной страницы запись опознаётся только по `sessionStorage` той же вкладки:
 * запись создаётся → черновик кладём → уходим на оплату → возвращаемся по `return_url` → читаем.
 * `sessionStorage`, а не `localStorage`: черновик одноразовый и привязан к вкладке, чужому
 * устройству он не достанется.
 *
 * ПДн: в черновике только uuid записи, ссылка провайдера и ISO-срок её действия. Телефон, почта
 * и имя сюда не попадают никогда — страница оплаты работает без авторизации.
 *
 * Storage инжектится в функции: тесты подставляют объект, браузер получает `sessionStorage`.
 * Любая ошибка хранилища (приватный режим, запрет cookie, квота) — не исключение, а `false`/`null`:
 * запись уже создана, и валить экран успеха из-за черновика нельзя.
 */

/** Ключ в `sessionStorage`. */
export const PAYMENT_DRAFT_KEY = 'hair-lab:payment-draft';

/** Адрес страницы оплаты без базы: `basePath` к `<Link>`/`router` добавляет Next. */
export const PAYMENT_PATH = '/booking/payment';

/** Черновик: id записи и данные ссылки на оплату из ответа создания записи. */
export type PaymentDraft = { appointmentId: string } & BookingPayment;

/** Что нужно знать, чтобы перевести клиента на страницу оплаты. */
export interface PaymentHandoff {
  draft: PaymentDraft;
  /** Путь страницы оплаты с `appointmentId` в query. */
  path: string;
}

/** Хранилище черновика: `sessionStorage` в браузере, объект — в тестах. */
export type PaymentDraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Путь страницы оплаты для записи. В query едет только uuid — никаких контактов:
 * ссылку пересылают в мессенджерах и она остаётся в истории браузера.
 */
export function paymentPagePath(appointmentId: string): string {
  return `${PAYMENT_PATH}?appointmentId=${encodeURIComponent(appointmentId)}`;
}

/**
 * Хранилище вкладки. `null` — доступа нет: `sessionStorage` запрещён настройками браузера
 * или падает при чтении (приватный режим Safari). На сервере `window` нет — тоже `null`.
 */
export function browserPaymentStorage(): PaymentDraftStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Проверка черновика контрактами: `null` — значения не наши, битые или обрезанные. */
function parseDraftRecord(record: unknown): PaymentDraft | null {
  if (typeof record !== 'object' || record === null) return null;
  const fields = record as Record<string, unknown>;

  const appointmentId = idSchema.safeParse(fields.appointmentId);
  if (!appointmentId.success) return null;

  const payment = bookingPaymentSchema.safeParse({
    confirmationUrl: fields.confirmationUrl,
    expiresAt: fields.expiresAt,
  });
  if (!payment.success) return null;

  return { appointmentId: appointmentId.data, ...payment.data };
}

/** Разбор значения из хранилища: не JSON или не по контракту — `null`. */
function parseDraft(raw: string): PaymentDraft | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  return parseDraftRecord(payload);
}

/**
 * Записать черновик. `false` — сохранить не удалось (нет хранилища, оно падает или места нет);
 * вызывающий код тогда показывает прямую ссылку на оплату, а не уводит на страницу без id.
 */
export function savePaymentDraft(
  draft: PaymentDraft,
  storage: PaymentDraftStorage | null = browserPaymentStorage(),
): boolean {
  if (storage === null) return false;

  const validated = parseDraftRecord(draft);
  if (validated === null) return false;

  try {
    storage.setItem(PAYMENT_DRAFT_KEY, JSON.stringify(validated));
    return true;
  } catch {
    return false;
  }
}

/**
 * Прочитать черновик. Битое значение удаляем сразу: иначе страница оплаты будет вечно
 * показывать «запись не определена», хотя ссылку можно получить заново.
 */
export function readPaymentDraft(
  storage: PaymentDraftStorage | null = browserPaymentStorage(),
): PaymentDraft | null {
  if (storage === null) return null;

  let raw: string | null;
  try {
    raw = storage.getItem(PAYMENT_DRAFT_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  const draft = parseDraft(raw);
  if (draft === null) {
    clearPaymentDraft(storage);
    return null;
  }
  return draft;
}

/** Удалить черновик. Ошибку хранилища глотаем: чистить нечего — не повод падать. */
export function clearPaymentDraft(
  storage: PaymentDraftStorage | null = browserPaymentStorage(),
): void {
  if (storage === null) return;
  try {
    storage.removeItem(PAYMENT_DRAFT_KEY);
  } catch {
    // Приватный режим: удалять нечего.
  }
}

/**
 * Перевод на оплату по созданной записи.
 *
 * `booking.payment` есть только когда оплата включена (`PAYMENTS_MODE != 'off'`) и запись ждёт
 * предоплаты. Поля нет — `null`, и визард показывает прежний экран «Запись создана»
 * без редиректа: при `off` поведение записи не меняется.
 */
export function paymentHandoff(booking: Pick<Booking, 'id' | 'payment'>): PaymentHandoff | null {
  if (booking.payment === undefined) return null;

  const draft = parseDraftRecord({ appointmentId: booking.id, ...booking.payment });
  if (draft === null) return null;

  return { draft, path: paymentPagePath(draft.appointmentId) };
}
