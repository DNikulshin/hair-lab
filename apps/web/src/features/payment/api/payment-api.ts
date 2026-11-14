import {
  idSchema,
  paymentStatusResponseSchema,
  type PaymentStatusResponse,
} from '@hair-lab/contracts';
import { withBasePath } from '@/shared/config/api';

/**
 * Статус оплаты записи из браузера.
 *
 * Ходим в same-origin Route Handler web (`/api/bookings/<id>/payment`): он проксирует запрос
 * во внутренний API и пробрасывает статус (CORS в API сознательно нет). В URL только uuid — ПДн
 * на странице оплаты нет, поэтому ответ можно отдавать без авторизации (`paymentStatusResponseSchema`).
 *
 * `cache: 'no-store'` здесь и в прокси: статус меняется вебхуком, кэш показал бы «ждём оплату»
 * уже после оплаты (и наоборот).
 *
 * Результат различает три исхода, потому что экран говорит о них по-разному: «оплата не найдена»,
 * «сервис недоступен, проверьте ещё раз» и собственно статус.
 */

export type PaymentStatusResult =
  | { ok: true; data: PaymentStatusResponse }
  /** Платежа нет (404) или id не uuid: при `PAYMENTS_MODE=off` оплата не подключается. */
  | { ok: false; kind: 'notFound' }
  /** Сеть, 5xx, битый payload: статус неизвестен, повтор имеет смысл. */
  | { ok: false; kind: 'unavailable' };

/** Статус оплаты записи. `signal` — отмена запроса при уходе со страницы. */
export async function fetchPaymentStatus(
  appointmentId: string,
  signal?: AbortSignal,
): Promise<PaymentStatusResult> {
  // Битый id не отправляем: ответ прокси (400) для экрана такой же, как «платежа нет».
  if (!idSchema.safeParse(appointmentId).success) return { ok: false, kind: 'notFound' };

  let response: Response;
  try {
    response = await fetch(
      withBasePath(`/api/bookings/${encodeURIComponent(appointmentId)}/payment`),
      { signal, cache: 'no-store' },
    );
  } catch {
    return { ok: false, kind: 'unavailable' };
  }

  // 404 — платежа нет; 400 — id не прошёл проверку контрактом в прокси.
  if (response.status === 404 || response.status === 400) return { ok: false, kind: 'notFound' };
  if (!response.ok) return { ok: false, kind: 'unavailable' };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, kind: 'unavailable' };
  }

  const parsed = paymentStatusResponseSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, kind: 'unavailable' };

  return { ok: true, data: parsed.data };
}
