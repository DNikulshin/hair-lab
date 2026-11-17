import { idSchema } from '@hair-lab/contracts';
import { jsonErrorResponse, proxyToApi } from '@/shared/api/route-proxy';

/**
 * `POST /api/admin/appointments/[id]/confirm` — подтверждение записи (`pending → confirmed`).
 *
 * Тела нет: идентификатор проверяется контрактом (uuid) до сети, действие определяется
 * путём. Cookie сотрудника и `Origin` прокси пробрасывает — по ним API проверяет сессию
 * и CSRF. Статусы API (401/404/409) и тело ошибки приходят как есть, идентификатор записи
 * не является персональными данными.
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
    `/admin/appointments/${encodeURIComponent(id)}/confirm`,
    { method: 'POST' },
    request,
  );
}
