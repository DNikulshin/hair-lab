import {
  mastersResponseSchema,
  servicesResponseSchema,
  type Master,
  type Service,
} from '@hair-lab/contracts';
import { apiConfig } from '@/shared/config/api';

/**
 * Чтение публичного каталога из API для Server Components.
 *
 * Возвращаем дискриминированный результат, а не пустой массив: витрина обязана
 * отличать «каталог пуст» от «API недоступен» и показать разные сообщения.
 * Ошибки не пробрасываем — страница не должна падать в 500 из-за лежащего API.
 *
 * Страницы, которые нас читают, рендерятся динамически (`force-dynamic`), поэтому
 * `fetch` выполняется на запрос, а не при сборке образа (API в момент сборки не нужен).
 *
 * Кэш данных сейчас отключён (`cache: 'no-store'`). Кэшировать можно только данные,
 * прошедшие валидацию контрактом, а кэш уровня `fetch` живёт до разбора JSON и
 * `safeParse`: HTTP-200 с невалидным payload лёг бы в кэш на весь `revalidate`,
 * и витрина показывала бы fallback уже после исправления API. Вернём кэш вместе
 * с on-demand revalidation (`revalidateTag`) отдельной задачей.
 *
 * В логах только статус и причина: тело ответа содержит данные каталога, его не печатаем.
 */

/** Результат запроса каталога: данные либо признак «получить не удалось». */
export type CatalogResult<T> = { ok: true; data: T } | { ok: false };

/**
 * Минимальная структурная часть Zod-схемы, нужная для валидации ответа.
 * Так web не зависит от `zod` напрямую: схема приходит из `@hair-lab/contracts`.
 */
interface ResponseParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false };
}

function warn(message: string): void {
  console.warn(`catalog-api: ${message}`);
}

async function fetchCatalog<T>(path: string, parser: ResponseParser<T>): Promise<CatalogResult<T>> {
  const url = `${apiConfig.baseUrl}${path}`;

  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-store' });
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'network error';
    warn(`GET ${path} не выполнен (${reason})`);
    return { ok: false };
  }

  if (!response.ok) {
    warn(`GET ${path} вернул статус ${response.status}`);
    return { ok: false };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    warn(`GET ${path} вернул не-JSON ответ`);
    return { ok: false };
  }

  const parsed = parser.safeParse(payload);
  if (!parsed.success) {
    warn(`GET ${path} вернул ответ, не соответствующий контракту`);
    return { ok: false };
  }

  return { ok: true, data: parsed.data };
}

/** `GET /services`: активные услуги салона в порядке витрины. */
export async function getServices(): Promise<CatalogResult<Service[]>> {
  const result = await fetchCatalog('/services', servicesResponseSchema);
  return result.ok ? { ok: true, data: result.data.items } : result;
}

/** `GET /masters`: активные мастера с их услугами. */
export async function getMasters(): Promise<CatalogResult<Master[]>> {
  const result = await fetchCatalog('/masters', mastersResponseSchema);
  return result.ok ? { ok: true, data: result.data.items } : result;
}
