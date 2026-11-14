import { isoDateTimeSchema } from '@hair-lab/contracts';
import type {
  CreatedPayment,
  CreatedRefund,
  CreatePaymentInput,
  CreateRefundInput,
  GatewayPayment,
  GatewayPaymentStatus,
  GatewayRefundStatus,
  PaymentGateway,
} from './payment-gateway';

/**
 * Клиент HTTP API ЮKassa (`https://api.yookassa.ru/v3`) на голом `fetch`: новых зависимостей
 * в проекте нет, а нужны три операции — создать платёж, прочитать его, вернуть деньги.
 *
 * Правила (issue #8):
 * - аутентификация — Basic Auth `shopId:secretKey`; секрет не попадает ни в текст ошибки,
 *   ни в лог: сообщения строятся только из кода HTTP и `code` из ответа провайдера;
 * - тело ответа об ошибке не пересказывается целиком (в нём может быть echo запроса);
 * - деньги — копейки: в запрос уходит строка `"3500.00"`, из ответа разбирается обратно
 *   целочисленной арифметикой, без float;
 * - персональные данные клиента не отправляются: `metadata` — только id записи;
 * - таймаут на каждый запрос (`AbortSignal`), чтобы зависший провайдер не держал обработчик;
 * - идемпотентность — заголовок `Idempotence-Key` от вызывающего;
 * - статус возврата маппится в закрытый тип домена (`GatewayRefundStatus`), неизвестное значение
 *   становится `unknown`, а не «выполненным возвратом»: деньги возвращает только `succeeded`.
 */

/** Валюта расчётов: салон один, мультивалютности нет. */
const CURRENCY = 'RUB';

export const DEFAULT_API_URL = 'https://api.yookassa.ru/v3';
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Допустимый `code` из ответа об ошибке: короткий идентификатор, без свободного текста. */
const ERROR_CODE = /^[a-z0-9_.-]{1,64}$/i;

/**
 * Ошибка запроса в ЮKassa. В тексте — только HTTP-код и `code` провайдера: ни тела ответа
 * (там бывает эхо запроса), ни секрета, ни заголовка авторизации.
 */
export class YookassaRequestError extends Error {
  /** HTTP-код ответа; `0` — до ответа дело не дошло (сеть, таймаут). */
  readonly httpStatus: number;
  /** `code` из тела ошибки ЮKassa (`invalid_credentials`, `not_found`, …), если он есть. */
  readonly code: string | undefined;

  constructor(message: string, options: { httpStatus: number; code?: string }) {
    super(message);
    this.name = 'YookassaRequestError';
    this.httpStatus = options.httpStatus;
    this.code = options.code;
  }
}

export interface YookassaClientOptions {
  shopId: string;
  /** Секрет магазина. В ошибки и логи не попадает. */
  secretKey: string;
  /** Базовый адрес API без хвостового слэша (по умолчанию — продовый). */
  apiUrl?: string;
  timeoutMs?: number;
  /** Подмена `fetch` в тестах; по умолчанию — глобальный `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Копейки → строка суммы для ЮKassa: `350000` → `"3500.00"`.
 * Только целочисленная арифметика: `(копейки / 100).toFixed(2)` на больших суммах теряет точность.
 *
 * Сумма меньше копейки — дефект вызывающего кода, а не данные пользователя: это `RangeError`.
 */
export function kopecksToAmountValue(kopecks: number): string {
  if (!Number.isInteger(kopecks) || kopecks <= 0) {
    throw new RangeError('Сумма платежа должна быть положительным целым числом копеек');
  }
  const major = Math.trunc(kopecks / 100);
  const minor = kopecks % 100;
  return `${major}.${String(minor).padStart(2, '0')}`;
}

/**
 * Строка суммы от ЮKassa → копейки: `"3500.00"` → `350000`. `null` — значение не разбирается
 * (тогда ответ провайдера считается некорректным). Дробных копеек не бывает.
 */
export function amountValueToKopecks(value: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (match === null) return null;

  const major = Number(match[1]);
  const minor = Number((match[2] ?? '').padEnd(2, '0'));
  const kopecks = major * 100 + minor;
  return Number.isSafeInteger(kopecks) ? kopecks : null;
}

/** Объект ответа произвольной формы: разбираем поля поштучно, без доверия к телу. */
type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringField(source: JsonObject | null, field: string): string | null {
  const value = source?.[field];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** `code` из тела ошибки: только короткий идентификатор, иначе `undefined`. */
function errorCodeOf(payload: JsonObject | null): string | undefined {
  const code = stringField(payload, 'code');
  return code !== null && ERROR_CODE.test(code) ? code : undefined;
}

/** Статус ЮKassa → статус домена. Неизвестный статус — некорректный ответ. */
function statusOf(raw: string): GatewayPaymentStatus | null {
  if (raw === 'succeeded') return 'succeeded';
  if (raw === 'canceled') return 'canceled';
  if (raw === 'pending' || raw === 'waiting_for_capture') return 'pending';
  return null;
}

/**
 * Статус возврата ЮKassa → статус домена. В отличие от платежа неизвестное значение — не ошибка:
 * деньги уже отправлены, и потерять ответ дороже, чем оставить возврат незавершённым.
 * Всё, кроме явно распознанного `succeeded`/`pending`/`canceled`, — `unknown`: такой возврат
 * не считается завершённым и повторяется вызывающим.
 */
function refundStatusOf(raw: string): GatewayRefundStatus {
  if (raw === 'succeeded' || raw === 'pending' || raw === 'canceled') return raw;
  return 'unknown';
}

/**
 * Клиент ЮKassa. Возвращает интерфейс `PaymentGateway`: доменная логика не знает про HTTP.
 */
export function createYookassaClient(options: YookassaClientOptions): PaymentGateway {
  const apiUrl = (options.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const authorization = `Basic ${Buffer.from(`${options.shopId}:${options.secretKey}`).toString('base64')}`;

  /** Запрос к API: JSON в обе стороны, ошибки — типизированные и без секретов. */
  async function request(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; idempotenceKey?: string } = {},
  ): Promise<JsonObject> {
    const headers: Record<string, string> = {
      Authorization: authorization,
      Accept: 'application/json',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotenceKey !== undefined) headers['Idempotence-Key'] = options.idempotenceKey;

    let response: Response;
    try {
      response = await fetchImpl(`${apiUrl}${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Причина не детализируется: в тексте ошибки `fetch` бывает URL, а в URL — ничего лишнего,
      // но и он в логах не нужен. Секрет в сообщение не попадает никогда.
      throw new YookassaRequestError('ЮKassa недоступна: сеть или таймаут', {
        httpStatus: 0,
        code: 'network_error',
      });
    }

    const raw = await response.text();
    let payload: JsonObject | null = null;
    if (raw !== '') {
      try {
        payload = asObject(JSON.parse(raw));
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const code = errorCodeOf(payload);
      throw new YookassaRequestError(`ЮKassa ответила HTTP ${response.status}`, {
        httpStatus: response.status,
        ...(code === undefined ? {} : { code }),
      });
    }

    if (payload === null) {
      throw new YookassaRequestError('Некорректный ответ ЮKassa: ожидался JSON-объект', {
        httpStatus: response.status,
        code: 'invalid_response',
      });
    }
    return payload;
  }

  function invalidResponse(reason: string): YookassaRequestError {
    return new YookassaRequestError(`Некорректный ответ ЮKassa: ${reason}`, {
      httpStatus: 200,
      code: 'invalid_response',
    });
  }

  return {
    async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
      if (input.idempotenceKey.trim() === '') {
        throw new RangeError('Ключ идемпотентности платежа не может быть пустым');
      }

      const payload = await request('POST', '/payments', {
        idempotenceKey: input.idempotenceKey,
        body: {
          amount: { value: kopecksToAmountValue(input.amountKopecks), currency: CURRENCY },
          // Деньги списываются сразу: двухстадийная оплата (холдирование на стороне ЮKassa)
          // не нужна — холд слота держим сами.
          capture: true,
          confirmation: { type: 'redirect', return_url: input.returnUrl },
          description: input.description,
          // ПДн не передаём: только внутренний id записи.
          metadata: { appointmentId: input.appointmentId },
        },
      });

      const yookassaPaymentId = stringField(payload, 'id');
      const confirmationUrl = stringField(asObject(payload['confirmation']), 'confirmation_url');
      if (yookassaPaymentId === null || confirmationUrl === null) {
        throw invalidResponse('нет id платежа или ссылки на оплату');
      }

      // Срок ссылки необязателен: невалидное значение отбрасываем, а не роняем создание платежа.
      const expiresAtRaw = stringField(payload, 'expires_at');
      const expiresAt =
        expiresAtRaw !== null && isoDateTimeSchema.safeParse(expiresAtRaw).success
          ? expiresAtRaw
          : undefined;

      return {
        yookassaPaymentId,
        confirmationUrl,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
    },

    async getPayment(id: string): Promise<GatewayPayment> {
      if (id.trim() === '') throw new RangeError('id платежа ЮKassa не может быть пустым');

      const payload = await request('GET', `/payments/${encodeURIComponent(id)}`);

      const paymentId = stringField(payload, 'id');
      const statusRaw = stringField(payload, 'status');
      const amountKopecks = amountValueToKopecks(
        stringField(asObject(payload['amount']), 'value') ?? '',
      );
      const status = statusRaw === null ? null : statusOf(statusRaw);

      if (paymentId === null || status === null || amountKopecks === null) {
        throw invalidResponse('нет id, статуса или суммы платежа');
      }

      return {
        id: paymentId,
        status,
        // `paid` приходит отдельным полем: `succeeded` без `paid: true` деньгами не считается.
        paid: payload['paid'] === true && status === 'succeeded',
        amountKopecks,
      };
    },

    async createRefund(input: CreateRefundInput): Promise<CreatedRefund> {
      if (input.idempotenceKey.trim() === '') {
        throw new RangeError('Ключ идемпотентности возврата не может быть пустым');
      }

      const payload = await request('POST', '/refunds', {
        idempotenceKey: input.idempotenceKey,
        body: {
          payment_id: input.yookassaPaymentId,
          amount: { value: kopecksToAmountValue(input.amountKopecks), currency: CURRENCY },
        },
      });

      const refundId = stringField(payload, 'id');
      const statusRaw = stringField(payload, 'status');
      if (refundId === null || statusRaw === null)
        throw invalidResponse('нет id или статуса возврата');

      return { refundId, status: refundStatusOf(statusRaw) };
    },
  };
}
