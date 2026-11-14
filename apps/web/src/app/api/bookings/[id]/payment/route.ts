import { idSchema } from '@hair-lab/contracts';
import { jsonErrorResponse, proxyToApi } from '@/shared/api/route-proxy';

/**
 * `GET /api/bookings/[id]/payment` — статус оплаты записи.
 *
 * Прокси нужен, как и остальным запросам браузера: CORS в API нет, а страница оплаты ходит
 * в свой origin. Идентификатор проверяется контрактом (uuid) до сети — битый путь не доходит
 * до API. В ответе только `{ status, appointmentStatus }`, поэтому авторизация не требуется.
 *
 * `proxyToApi` ставит `Cache-Control: no-store` (как и для остальных ответов с персональными
 * данными): статус меняется вебхуком, кэш показал бы «ждём оплату» уже после оплаты.
 * Статусы API пробрасываются как есть: `404` — платежа нет (в том числе при `PAYMENTS_MODE=off`),
 * страница показывает «оплата не найдена».
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  if (!idSchema.safeParse(id).success) {
    return jsonErrorResponse(400, 'validation_error', 'Некорректный идентификатор записи');
  }

  return proxyToApi(`/bookings/${encodeURIComponent(id)}/payment`, { method: 'GET' }, request);
}
