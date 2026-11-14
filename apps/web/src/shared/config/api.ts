import { siteConfig } from './site';

/**
 * Адрес API для **серверных** запросов web → api (Server Components, Route Handlers).
 *
 * `API_URL` — runtime-переменная окружения: она читается при запуске сервера и не
 * встраивается в клиентский бандл. В контейнере (docker-compose.prod.yml) это
 * внутренний адрес `http://api:3001`, при локальной разработке — `http://localhost:3001`.
 * Если переменная не задана, используется публичный адрес из `NEXT_PUBLIC_API_URL`.
 *
 * Клиентская часть — только `withBasePath` (см. ниже): браузер ходит на относительные пути
 * внутри своего origin, префикс добавляется по `basePath`.
 */
function resolveBaseUrl(): string {
  const fromEnv = process.env.API_URL?.trim();
  const raw = fromEnv && fromEnv.length > 0 ? fromEnv : siteConfig.apiUrl;
  // Хвостовой слэш убираем, чтобы пути склеивались как `${baseUrl}/services`.
  return raw.replace(/\/+$/, '');
}

export const apiConfig = {
  baseUrl: resolveBaseUrl(),
} as const;

export type ApiConfig = typeof apiConfig;

/**
 * Префикс для **клиентских** запросов к внутренним route handlers: браузерный `fetch`
 * не знает про `basePath` (Next добавляет его только к `<Link>` и маршрутам).
 *
 * Значение встраивается на сборке из `NEXT_BASE_PATH` (см. `next.config.ts`).
 * Пустая база — путь не меняется: прод и тесты работают как раньше.
 */
const CLIENT_BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

/**
 * Чистая функция для тестов: добавляет базу к абсолютному пути.
 * Относительные пути и `http(s)://` не трогаем — их смысл не зависит от базы.
 */
export function applyBasePath(base: string, path: string): string {
  const normalized = base.replace(/\/+$/, '');
  if (normalized === '' || !path.startsWith('/')) return path;
  return `${normalized}${path}`;
}

/** Добавляет `basePath` к абсолютному пути: `/api/slots` → `/absproxy/3002/api/slots`. */
export function withBasePath(path: string): string {
  return applyBasePath(CLIENT_BASE_PATH, path);
}
