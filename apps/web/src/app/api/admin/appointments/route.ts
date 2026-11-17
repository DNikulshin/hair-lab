import { adminAppointmentsQuerySchema } from '@hair-lab/contracts';
import { jsonErrorResponse, proxyToApi } from '@/shared/api/route-proxy';

/**
 * `GET /api/admin/appointments?date=…` — записи одного дня в поясе салона.
 *
 * Дата проверяется контрактом (`calendarDateSchema`) до сети: битая или несуществующая
 * дата не доходит до API. Cookie сотрудника, `Origin` и `Referer` прокси пробрасывает —
 * по ним API проверяет сессию. Ответ содержит телефоны клиентов, поэтому кэша нет
 * (`Cache-Control: no-store` ставит прокси), а тело запроса не логируется.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const search = new URL(request.url).searchParams;

  const parsed = adminAppointmentsQuerySchema.safeParse({
    date: search.get('date') ?? undefined,
  });

  if (!parsed.success) {
    return jsonErrorResponse(400, 'validation_error', 'Некорректная дата запроса');
  }

  const upstreamQuery = new URLSearchParams({ date: parsed.data.date });

  return proxyToApi(`/admin/appointments?${upstreamQuery.toString()}`, {}, request);
}
