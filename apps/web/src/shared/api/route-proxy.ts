import {
  apiErrorSchema,
  type ApiError,
  type ApiErrorCode,
  type ApiErrorDetail,
} from '@hair-lab/contracts';
import { apiConfig } from '@/shared/config/api';

/**
 * Проксирование запросов браузера в API через Route Handlers web.
 *
 * Зачем прокси, а не прямой вызов API из браузера: CORS в `apps/api` не настраивается
 * (нативному клиенту Expo он не нужен), а браузеру нужен same-origin. Поэтому браузер
 * ходит в `/api/*` своего домена, а Route Handler переписывает запрос во внутренний адрес
 * API (`apiConfig.baseUrl` — runtime-переменная, в клиентский бандл не попадает).
 *
 * Инварианты:
 * - статус API пробрасывается как есть (200/201/400/404/409/5xx), поэтому клиент различает
 *   «занято», «не найдено» и «сервис недоступен» без разбора текста;
 * - тело любой ошибки — `apiErrorSchema`: клиент читает `error.code` и `error.details`;
 * - `Cache-Control: no-store`: ответы содержат персональные данные, кэшировать их нельзя
 *   (ни браузеру, ни промежуточным прокси);
 * - недоступность API — 503, некорректный ответ API — 502: страница записи не падает,
 *   а показывает понятное сообщение;
 * - в логи идут только метод, путь, статус и класс ошибки. Тело запроса содержит телефон
 *   клиента и не логируется ни в каком виде.
 */

/** Заголовки ответа для всего, что связано с записью: персональные данные не кэшируем. */
export const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

/** Ограничение ожидания API: Route Handler не должен висеть дольше пользовательского запроса. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/** Код ошибки по HTTP-статусу: та же таблица, что в обработчике ошибок API. */
const STATUS_TO_CODE: Record<number, ApiErrorCode> = {
  400: 'validation_error',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  429: 'rate_limited',
};

/** Нейтральные тексты: наружу не уходят ни стектрейсы, ни значения полей. */
const DEFAULT_MESSAGES: Record<ApiErrorCode, string> = {
  validation_error: 'Некорректные данные запроса',
  unauthorized: 'Требуется авторизация',
  forbidden: 'Недостаточно прав',
  not_found: 'Не найдено',
  conflict: 'Конфликт состояния',
  slot_unavailable: 'Выбранное время уже занято',
  rate_limited: 'Слишком много запросов',
  internal_error: 'Внутренняя ошибка сервера',
};

/** Ответ с телом по контракту `apiErrorSchema`. */
export function jsonErrorResponse(
  status: number,
  code: ApiErrorCode,
  message = DEFAULT_MESSAGES[code],
  details?: readonly ApiErrorDetail[],
): Response {
  const body: ApiError = {
    error: {
      code,
      message,
      ...(details !== undefined && details.length > 0 ? { details: [...details] } : {}),
    },
  };
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

function statusCodeOf(status: number): ApiErrorCode {
  if (status >= 500) return 'internal_error';
  return STATUS_TO_CODE[status] ?? 'validation_error';
}

/**
 * Запрос в API с пробросом статуса и тела по контракту.
 * @param path путь API без базового адреса, например `/slots?date=2030-03-04…`.
 * @param init параметры `fetch`; тело запроса не логируется.
 */
export async function proxyToApi(
  path: string,
  init: RequestInit = {},
  incomingRequest?: Request,
): Promise<Response> {
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);
  for (const name of ['cookie', 'origin', 'referer'] as const) {
    const value = incomingRequest?.headers.get(name);
    if (value !== null && value !== undefined) headers.set(name, value);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiConfig.baseUrl}${path}`, {
      ...init,
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'network error';
    console.warn(`route-proxy: ${method} ${path} не выполнен (${reason})`);
    return jsonErrorResponse(503, 'internal_error', 'Сервис записи временно недоступен');
  }

  const responseHeaders = new Headers(NO_STORE_HEADERS);
  responseHeaders.set(
    'Content-Type',
    upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
  );
  // Нужны все Set-Cookie заголовки (не склеивать через запятую: Expires содержит запятую).
  for (const cookie of upstream.headers.getSetCookie()) responseHeaders.append('Set-Cookie', cookie);
  const relay = (body: BodyInit | null): Response =>
    new Response(body, { status: upstream.status, headers: responseHeaders });

  const text = await upstream.text();
  if (text.length === 0) return relay(null);

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    console.warn(`route-proxy: ${method} ${path} вернул не-JSON ответ (${upstream.status})`);
    return jsonErrorResponse(502, 'internal_error', 'Сервис записи вернул некорректный ответ');
  }

  if (!upstream.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    if (!parsed.success) {
      console.warn(
        `route-proxy: ${method} ${path} вернул ошибку не по контракту (${upstream.status})`,
      );
      return jsonErrorResponse(
        upstream.status >= 500 ? 502 : upstream.status,
        statusCodeOf(upstream.status),
      );
    }
    return relay(JSON.stringify(parsed.data));
  }

  return relay(JSON.stringify(payload));
}
