import { idSchema } from '@hair-lab/contracts';
import { jsonErrorResponse, proxyToApi } from '@/shared/api/route-proxy';

/**
 * `POST /api/admin/appointments/[id]/no-show` — клиент не пришёл.
 *
 * Тела нет: идентификатор проверяется контрактом (uuid) до сети. Cookie сотрудника
 * и `Origin` прокси пробрасывает — по ним API проверяет сессию и CSRF. Статусы API
 * (401/404/409) приходят как есть.
 */
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  if (!idSchema.safeParse(id).success) {
    return jsonErrorResponse(400, 'validation_error', 'Некорректный идентификатор записи');
  }

  return proxyToApi(
    `/admin/appointments/${encodeURIComponent(id)}/no-show`,
    { method: 'POST' },
    request,
  );
}
