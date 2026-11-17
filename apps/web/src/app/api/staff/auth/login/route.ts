import { staffLoginRequestSchema } from '@hair-lab/contracts';
import { jsonErrorResponse, proxyToApi } from '@/shared/api/route-proxy';

/**
 * `POST /api/staff/auth/login` — вход сотрудника.
 *
 * Тело проверяется тем же контрактом, что и в API: клиент получает 400 сразу, не дожидаясь
 * сети. `Set-Cookie` с сессией сотрудника (`hl_staff_session`, httpOnly) прокси пробрасывает
 * как есть — в JS сессия не попадает. `Origin`/`Referer` тоже пробрасываются: по ним API
 * проверяет CSRF. Тело (почта и пароль) не логируется.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonErrorResponse(400, 'validation_error', 'Некорректный JSON в теле запроса');
  }

  const parsed = staffLoginRequestSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return jsonErrorResponse(400, 'validation_error', 'Проверьте данные формы', details);
  }

  return proxyToApi(
    '/staff/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data),
    },
    request,
  );
}
