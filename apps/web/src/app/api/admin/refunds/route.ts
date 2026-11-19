import { adminRefundsQuerySchema } from '@hair-lab/contracts';
import { jsonErrorResponse, proxyToApi } from '@/shared/api/route-proxy';

/**
 * `GET /api/admin/refunds?scope=…&from=…&to=…` — обзор возвратов в админке.
 *
 * Параметры проверяются контрактом (`adminRefundsQuerySchema`) до сети: неизвестный `scope`,
 * битая дата и `from` позже `to` не доходят до API. Значения по умолчанию подставляет схема,
 * поэтому в API уходит явный `scope`.
 *
 * Cookie сотрудника, `Origin` и `Referer` прокси пробрасывает — по ним API проверяет сессию.
 * Ответ содержит телефон клиента, поэтому кэша нет (`Cache-Control: no-store` ставит прокси),
 * а тело запроса и параметры не логируются.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const search = new URL(request.url).searchParams;

  const parsed = adminRefundsQuerySchema.safeParse({
    scope: search.get('scope') ?? undefined,
    from: search.get('from') ?? undefined,
    to: search.get('to') ?? undefined,
  });

  if (!parsed.success) {
    return jsonErrorResponse(400, 'validation_error', 'Некорректные параметры запроса');
  }

  const upstreamQuery = new URLSearchParams({ scope: parsed.data.scope });
  if (parsed.data.from !== undefined) upstreamQuery.set('from', parsed.data.from);
  if (parsed.data.to !== undefined) upstreamQuery.set('to', parsed.data.to);

  return proxyToApi(`/admin/refunds?${upstreamQuery.toString()}`, {}, request);
}
