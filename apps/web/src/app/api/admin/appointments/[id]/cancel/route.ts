import { adminCancelRequestSchema, idSchema } from '@hair-lab/contracts';
import { jsonErrorResponse, proxyToApi } from '@/shared/api/route-proxy';

/**
 * `POST /api/admin/appointments/[id]/cancel` — отмена салоном с причиной.
 *
 * Идентификатор и тело проверяются контрактами до сети: битый путь и пустая причина
 * получают 400 сразу. Причина обязательна — без неё салонная отмена неотличима
 * от клиентской. Cookie сотрудника и `Origin` прокси пробрасывает — по ним API проверяет
 * сессию и CSRF. Текст причины — не персональные данные клиента, но тело всё равно
 * не логируется.
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

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonErrorResponse(400, 'validation_error', 'Некорректный JSON в теле запроса');
  }

  const parsed = adminCancelRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return jsonErrorResponse(400, 'validation_error', 'Укажите причину отмены');
  }

  return proxyToApi(
    `/admin/appointments/${encodeURIComponent(id)}/cancel`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data),
    },
    request,
  );
}
