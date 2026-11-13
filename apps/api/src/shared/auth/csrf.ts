import type { FastifyInstance } from 'fastify';
import { buildError } from '../http/error-handler';

/**
 * CSRF-защита для запросов, меняющих состояние.
 *
 * Cookie сессии — `SameSite=Lax`, поэтому межсайтовый POST её не отправит. Этого мало:
 * `Lax` не защищает от запросов внутри того же сайта (XSS на поддомене) и от старых
 * браузеров, а JSON-тело само по себе не гарантирует, что запрос пришёл из нашего UI.
 * Второй слой — проверка `Origin` (у браузера его нельзя подделать из JS), с откатом
 * на `Referer`, если `Origin` не пришёл.
 *
 * Правила проверки (только для методов кроме GET/HEAD/OPTIONS):
 * - `Origin` есть → его origin должен быть в allowlist;
 * - `Origin` нет, `Referer` есть → origin из `Referer` должен быть в allowlist;
 * - ни `Origin`, ни `Referer` нет → запрос не из браузера (curl, мобильный клиент,
 *   серверный вызов) → пропускаем: cookie браузер туда не подставит автоматически.
 *
 * Значения заголовков не логируются: `Referer` может содержать путь с параметрами.
 * Нарушение — 403 `forbidden` в общем формате ошибок.
 */

/** Методы без побочных эффектов: их CSRF не касается. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Проверяемый запрос: метод и заголовки `Origin`/`Referer` (значения как есть). */
export interface OriginCheckInput {
  method: string;
  origin?: string | undefined;
  referer?: string | undefined;
}

/** Origin строки в каноническом виде (`scheme://host:port`), либо `null`. */
export function normalizeOrigin(value: string): string | null {
  try {
    const { origin } = new URL(value);
    // Литерал `Origin: null` (sandbox-iframe, file://) разбирается в исключение выше,
    // а пустой origin (`file:`) отбрасываем отдельно.
    return origin === '' || origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Allowlist из `APP_URL` и `CORS_ORIGINS`: значения нормализуются до origin,
 * пустые и невалидные отбрасываются (в конфиге они не должны ломать защиту).
 */
export function createOriginAllowList(origins: readonly string[]): readonly string[] {
  const normalized = new Set<string>();
  for (const raw of origins) {
    const origin = normalizeOrigin(raw.trim());
    if (origin !== null) normalized.add(origin);
  }
  return [...normalized];
}

/**
 * Пропускать ли запрос. Чистая функция: сеть, Fastify и логи не нужны —
 * по ней проверяется вся матрица «Origin/Referer/нет ничего».
 */
export function isOriginAllowed(
  input: OriginCheckInput,
  allowedOrigins: readonly string[],
): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return true;

  const allowed = new Set(allowedOrigins);

  if (input.origin !== undefined && input.origin !== '') {
    const origin = normalizeOrigin(input.origin);
    // `Origin: null` (sandbox-iframe, file://) и битые значения — недоверенные.
    return origin !== null && allowed.has(origin);
  }

  if (input.referer !== undefined && input.referer !== '') {
    const origin = normalizeOrigin(input.referer);
    return origin !== null && allowed.has(origin);
  }

  return true;
}

/** Заголовок запроса как строка (Fastify отдаёт `string | string[] | undefined`). */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Хук на все запросы приложения: unsafe-метод с чужим origin получает 403.
 * Регистрируется один раз (плагин аутентификации), allowlist приходит из композиции.
 */
export function registerOriginGuard(app: FastifyInstance, allowedOrigins: readonly string[]): void {
  app.addHook('onRequest', async (request, reply) => {
    const allowed = isOriginAllowed(
      {
        method: request.method,
        origin: headerValue(request.headers.origin),
        referer: headerValue(request.headers.referer),
      },
      allowedOrigins,
    );
    if (allowed) return;

    request.log.warn(
      { requestId: request.id, method: request.method, url: request.url.split('?')[0] },
      'csrf: запрос с недоверенным origin отклонён',
    );
    await reply.status(403).send(buildError('forbidden', request.id));
  });
}
