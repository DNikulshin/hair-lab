import { accountBookingsQuerySchema } from '@hair-lab/contracts';
import { jsonErrorResponse, proxyToApi } from '@/shared/api/route-proxy';

/**
 * `GET /api/account/bookings` — мои записи (предстоящие или прошлые).
 *
 * Параметры проверяются тем же контрактом, что и в API, и только потом уходят наверх:
 * клиент получает 400 сразу, не дожидаясь сети. Сессии в браузере нет — запрос уходит
 * без cookie, и API отвечает 401, который прокси пробрасывает как есть.
 *
 * Персональные данные не кэшируются: `Cache-Control: no-store` ставит сам прокси
 * (и браузеру, и промежуточным прокси), тело запроса не логируется.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const search = new URL(request.url).searchParams;

  const parsed = accountBookingsQuerySchema.safeParse({
    limit: search.get('limit') ?? undefined,
    cursor: search.get('cursor') ?? undefined,
    scope: search.get('scope') ?? undefined,
  });

  if (!parsed.success) {
    return jsonErrorResponse(400, 'validation_error', 'Некорректные параметры запроса');
  }

  const upstreamQuery = new URLSearchParams({
    scope: parsed.data.scope,
    limit: String(parsed.data.limit),
  });
  if (parsed.data.cursor !== undefined) upstreamQuery.set('cursor', parsed.data.cursor);

  return proxyToApi(`/account/bookings?${upstreamQuery.toString()}`, {}, request);
}
