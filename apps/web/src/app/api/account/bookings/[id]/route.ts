import { idSchema } from '@hair-lab/contracts';
import { jsonErrorResponse, proxyToApi } from '@/shared/api/route-proxy';

/**
 * `DELETE /api/account/bookings/[id]` — отмена своей записи.
 *
 * Тела нет: отмена — действие над записью, причина отмены ставится сервером.
 * Идентификатор проверяется контрактом (uuid) до сети: битый путь не доходит до API.
 * Cookie, `Origin` и `Referer` прокси пробрасывает — по ним API проверяет сессию и CSRF.
 * Статусы и тело ошибок (401/404/409) приходят от API как есть.
 */
export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  if (!idSchema.safeParse(id).success) {
    return jsonErrorResponse(400, 'validation_error', 'Некорректный идентификатор записи');
  }

  return proxyToApi(`/account/bookings/${encodeURIComponent(id)}`, { method: 'DELETE' }, request);
}
