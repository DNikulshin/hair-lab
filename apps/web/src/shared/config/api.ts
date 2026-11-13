import { siteConfig } from './site';

/**
 * Адрес API для **серверных** запросов web → api (Server Components, Route Handlers).
 *
 * `API_URL` — runtime-переменная окружения: она читается при запуске сервера и не
 * встраивается в клиентский бандл. В контейнере (docker-compose.prod.yml) это
 * внутренний адрес `http://api:3001`, при локальной разработке — `http://localhost:3001`.
 * Если переменная не задана, используется публичный адрес из `NEXT_PUBLIC_API_URL`.
 *
 * В клиентские компоненты этот модуль не импортируем: браузер ходит на публичный адрес.
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
