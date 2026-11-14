import { buildSwSource } from '@/features/pwa';
import { normalizeBasePath } from '@/shared/config/base-path';

/**
 * Service worker как Route Handler.
 *
 * Почему не `public/sw.js`: политика (`features/pwa/lib/sw-policy.ts`) остаётся
 * типизированной и тестируемой, версия кэшей и база подставляются при выдаче,
 * а заголовки мы контролируем сами:
 *
 * - `Content-Type: application/javascript; charset=utf-8` — браузеры требуют JS-тип;
 * - `Cache-Control: no-store` — иначе браузер может годами не замечать новую версию;
 * - `Service-Worker-Allowed: /` — SW, отданный с глубокого пути, может управлять корнем.
 */
export function GET(): Response {
  const source = buildSwSource({ base: normalizeBasePath(process.env.NEXT_BASE_PATH) });

  return new Response(source, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Service-Worker-Allowed': '/',
    },
  });
}
