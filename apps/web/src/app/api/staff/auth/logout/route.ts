import { proxyToApi } from '@/shared/api/route-proxy';

/**
 * `POST /api/staff/auth/logout` — выход сотрудника.
 *
 * Тела нет: сессия опознаётся по cookie. API удаляет сессию и очищает cookie, прокси
 * пробрасывает `Set-Cookie` (в том числе с истёкшим сроком) как есть, поэтому после ответа
 * браузер уже без сессии сотрудника. Клиентская cookie `hl_session` не затрагивается.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return proxyToApi('/staff/auth/logout', { method: 'POST' }, request);
}
