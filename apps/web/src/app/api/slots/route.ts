import { slotsQuerySchema } from '@hair-lab/contracts';
import { jsonErrorResponse, proxyToApi } from '@/shared/api/route-proxy';

/**
 * `GET /api/slots` — свободные слоты для формы записи.
 *
 * Браузер не ходит в API напрямую (CORS не настроен и не нужен): Route Handler проверяет
 * параметры контрактом и проксирует запрос, пробрасывая статус и `Cache-Control: no-store`.
 * Телефон клиента в query не передаётся — только услуга, мастер и дата.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const search = new URL(request.url).searchParams;

  const parsed = slotsQuerySchema.safeParse({
    serviceId: search.get('serviceId') ?? undefined,
    masterId: search.get('masterId') ?? undefined,
    date: search.get('date') ?? undefined,
  });

  if (!parsed.success) {
    return jsonErrorResponse(400, 'validation_error', 'Некорректные параметры запроса');
  }

  const upstreamQuery = new URLSearchParams({
    serviceId: parsed.data.serviceId,
    date: parsed.data.date,
  });
  if (parsed.data.masterId !== undefined) upstreamQuery.set('masterId', parsed.data.masterId);

  return proxyToApi(`/slots?${upstreamQuery.toString()}`);
}
