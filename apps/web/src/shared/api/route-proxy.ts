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
 *   клиента и не логируется ни в каком виде; адрес клиента (см. ниже) в логи web тоже не пишется.
 *
 * Адрес клиента (`x-forwarded-for` / `x-real-ip`) пересылается в API: лимиты частоты API
 * (`@fastify/rate-limit`, в том числе `/auth/*` и `POST /bookings`) считаются по `req.ip`,
 * а `trustProxy: true` берёт его из `x-forwarded-for`. Без пересылки API видит адрес
 * контейнера web — один на всех клиентов, — и лимит становится общим на весь сайт: 11-я
 * запись за 10 минут от разных людей получала бы 429. Значение доверенное: nginx стоит
 * единственной точкой входа и перезаписывает `x-forwarded-for $remote_addr` (а не дописывает),
 * поэтому подделать его из браузера нельзя. Пересылается только строго валидный одиночный
 * адрес: иначе наверх уходило бы подконтрольное клиенту значение ключа лимита. Проверка
 * строгая — значение разбирается как настоящий IP, а не как «строка из допустимых символов»:
 * `::::`, `1.2.3.4.5` и `ab.cd` адресами не считаются.
 */

/** Заголовки ответа для всего, что связано с записью: персональные данные не кэшируем. */
export const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

/** Ограничение ожидания API: Route Handler не должен висеть дольше пользовательского запроса. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/** Максимальная длина IPv6 в текстовом виде (`fd00:...`, 39 символов) с запасом до IPv4-хвоста. */
const MAX_IPV6_LENGTH = 45;

/** Октет IPv4: 0–255 без ведущих нулей (`999` и `01` не проходят). */
const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';

/** Ровно четыре октета и ничего больше: запятые, пробелы и CR/LF не проходят. */
const IPV4_PATTERN = new RegExp(`^(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}$`);

/** Группа IPv6: от одной до четырёх hex-цифр. */
const IPV6_GROUP_PATTERN = /^[0-9a-fA-F]{1,4}$/;

function isIpv4Address(value: string): boolean {
  return IPV4_PATTERN.test(value);
}

/**
 * Группы IPv6 по порядку; `undefined` — строку нельзя разобрать как IPv6.
 *
 * `::` разрешено не больше одного раза, пустые группы вне сжатия запрещены, а последняя
 * группа может быть IPv4-хвостом (`::ffff:192.0.2.1`).
 */
function parseIpv6Groups(value: string): string[] | undefined {
  const chunks = value.split('::');
  if (chunks.length > 2) return undefined;

  const groups: string[] = [];
  for (const chunk of chunks) {
    if (chunk === '') continue;
    for (const group of chunk.split(':')) {
      if (group === '') return undefined;
      groups.push(group);
    }
  }

  const lastIndex = groups.length - 1;
  for (const [index, group] of groups.entries()) {
    if (index === lastIndex && group.includes('.')) {
      if (!isIpv4Address(group)) return undefined;
      continue;
    }
    if (!IPV6_GROUP_PATTERN.test(group)) return undefined;
  }
  return groups;
}

function isIpv6Address(value: string): boolean {
  if (!value.includes(':') || value.length > MAX_IPV6_LENGTH) return false;
  const groups = parseIpv6Groups(value);
  if (groups === undefined) return false;
  // IPv4-хвост занимает две группы; сжатие `::` обязано что-то заменять, поэтому групп меньше восьми.
  const units = groups.length + ((groups.at(-1) ?? '').includes('.') ? 1 : 0);
  return value.includes('::') ? units <= 7 : units === 8;
}

/** Строгая проверка адреса клиента: ровно один настоящий IPv4 или IPv6, без зависимостей. */
function isClientAddress(value: string): boolean {
  return isIpv4Address(value) || isIpv6Address(value);
}

/**
 * Адрес клиента из входящего запроса к Route Handler.
 *
 * `x-forwarded-for` пишет nginx (перезаписью), `x-real-ip` — запасной вариант на случай
 * конфигурации без XFF. Не прошедшее проверку значение не используется и не логируется.
 */
function clientAddressOf(request?: Request): string | undefined {
  for (const name of ['x-forwarded-for', 'x-real-ip'] as const) {
    const value = request?.headers.get(name);
    if (value !== null && value !== undefined && isClientAddress(value)) return value;
  }
  return undefined;
}

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
 * @param incomingRequest входящий запрос Route Handler: из него пересылаются `cookie`,
 * `origin`, `referer` и адрес клиента для лимитов API.
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
  const clientAddress = clientAddressOf(incomingRequest);
  if (clientAddress !== undefined) headers.set('x-forwarded-for', clientAddress);

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
  for (const cookie of upstream.headers.getSetCookie())
    responseHeaders.append('Set-Cookie', cookie);
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
