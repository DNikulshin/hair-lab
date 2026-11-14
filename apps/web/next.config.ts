import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * Нормализует базовый путь для работы за reverse proxy:
 * `undefined`/пусто → без префикса, иначе гарантирует ведущий `/` и отсутствие хвостового.
 */
function normalizeBasePath(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw || raw === '/') return undefined;
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

/** Список источников, которым разрешены дев-запросы к `/_next/*` (через запятую). */
function parseOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Переменные нужны только для разработки через прокси (code-server / VS Code tunnels).
 * В проде и в Docker они не задаются: сайт за nginx работает от корня.
 *
 * - `NEXT_BASE_PATH` — приложение живёт под префиксом и получает его целиком
 *   (режим code-server `/absproxy/<port>/`): работают и ссылки, и ассеты, и HMR.
 * - `NEXT_ASSET_PREFIX` — прокси срезает префикс (режим `/proxy/<port>/`): тогда
 *   префикс нужен только для статики; навигация по абсолютным ссылкам при этом не работает.
 * - `NEXT_ALLOWED_DEV_ORIGINS` — хосты, с которых dev-сервер принимает запросы к `/_next/*`
 *   (Next блокирует кросс-доменные дев-запросы).
 */
const basePath = normalizeBasePath(process.env.NEXT_BASE_PATH);
const assetPrefix = normalizeBasePath(process.env.NEXT_ASSET_PREFIX);
const allowedDevOrigins = parseOrigins(process.env.NEXT_ALLOWED_DEV_ORIGINS);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // База доступна клиентскому коду: Next добавляет basePath к <Link> и маршрутам,
  // но не к произвольным fetch. Значение встраивается в бандл на сборке.
  env: { NEXT_PUBLIC_BASE_PATH: basePath ?? '' },
  // Контракты поставляются собранными (tsup), поэтому transpilePackages не нужен.
  poweredByHeader: false,
  // Docker-образ: самодостаточная сборка без node_modules в runtime.
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  ...(basePath ? { basePath } : {}),
  ...(assetPrefix ? { assetPrefix } : {}),
  ...(allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),
};

export default nextConfig;
