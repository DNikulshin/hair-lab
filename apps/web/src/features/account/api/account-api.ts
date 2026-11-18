import {
  accountBookingResponseSchema,
  accountBookingsResponseSchema,
  authResponseSchema,
  okResponseSchema,
  type AccountBooking,
  type AccountBookingsResponse,
  type ClientAccount,
} from '@hair-lab/contracts';
import { withBasePath } from '@/shared/config/api';

/**
 * Запросы кабинета клиента из браузера.
 *
 * Ходим только в same-origin Route Handlers web (`/api/account/bookings`,
 * `/api/auth/me`): они проксируют запрос во внутренний API и пробрасывают статус
 * (CORS в API сознательно нет). Cookie сессии подставляется браузером сама,
 * токена в JS и в `localStorage` нет.
 *
 * Ответы валидируются контрактом (`safeParse`): невалидный payload — «сервис недоступен»,
 * а не пустой список. Это важно: пустой список и сбой выглядят по-разному для клиента,
 * и путать их нельзя — человек решит, что записей нет.
 *
 * Правило отмены (два часа, статусы) на клиенте не дублируется: UI читает `cancellable`.
 */

/** Причина неуспеха: HTTP-ответ API (тело уже разобрано) или отсутствие связи. */
export type AccountFailure = { kind: 'network' } | { kind: 'http'; status: number; body: unknown };

export type AccountResult<T> = { ok: true; data: T } | { ok: false; failure: AccountFailure };

/**
 * Текущий клиент (`GET /auth/me`): `401` — сессии нет. Возвращается аккаунт целиком
 * (`id`, `email`, `emailVerifiedAt`): кабинет показывает, под кем открыт вход.
 */
export async function fetchCurrentClient(): Promise<AccountResult<ClientAccount>> {
  let response: Response;
  try {
    response = await fetch(withBasePath('/api/auth/me'), { cache: 'no-store' });
  } catch {
    return { ok: false, failure: { kind: 'network' } };
  }

  const payload = await readPayload(response);
  if (!response.ok) {
    return { ok: false, failure: { kind: 'http', status: response.status, body: payload } };
  }

  const parsed = authResponseSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, failure: { kind: 'network' } };
  return { ok: true, data: parsed.data.client };
}

/**
 * Выход клиента (`POST /auth/logout`): API гасит сессию и стирает cookie.
 * `ok: true` означает, что сервер подтвердил выход — только тогда экран уходит с кабинета.
 */
export async function logoutClient(): Promise<AccountResult<true>> {
  let response: Response;
  try {
    response = await fetch(withBasePath('/api/auth/logout'), {
      method: 'POST',
      cache: 'no-store',
    });
  } catch {
    return { ok: false, failure: { kind: 'network' } };
  }

  const payload = await readPayload(response);
  if (!response.ok) {
    return { ok: false, failure: { kind: 'http', status: response.status, body: payload } };
  }
  if (!okResponseSchema.safeParse(payload).success) {
    return { ok: false, failure: { kind: 'network' } };
  }
  return { ok: true, data: true };
}

export interface AccountBookingsRequest {
  scope: 'upcoming' | 'past';
  limit?: number;
  cursor?: string;
}

/** Страница записей выбранного `scope`. */
export async function fetchAccountBookings(
  params: AccountBookingsRequest,
): Promise<AccountResult<AccountBookingsResponse>> {
  const search = new URLSearchParams({ scope: params.scope });
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.cursor !== undefined) search.set('cursor', params.cursor);

  let response: Response;
  try {
    response = await fetch(withBasePath(`/api/account/bookings?${search.toString()}`), {
      cache: 'no-store',
    });
  } catch {
    return { ok: false, failure: { kind: 'network' } };
  }

  const payload = await readPayload(response);
  if (!response.ok) {
    return { ok: false, failure: { kind: 'http', status: response.status, body: payload } };
  }

  const parsed = accountBookingsResponseSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, failure: { kind: 'network' } };
  return { ok: true, data: parsed.data };
}

/**
 * Отмена своей записи. Ответ — обновлённая запись: экран правит элемент локально,
 * без повторной загрузки списка. Повторная отмена идемпотентна (200).
 */
export async function cancelBooking(id: string): Promise<AccountResult<AccountBooking>> {
  let response: Response;
  try {
    response = await fetch(withBasePath(`/api/account/bookings/${encodeURIComponent(id)}`), {
      method: 'DELETE',
      cache: 'no-store',
    });
  } catch {
    return { ok: false, failure: { kind: 'network' } };
  }

  const payload = await readPayload(response);
  if (!response.ok) {
    return { ok: false, failure: { kind: 'http', status: response.status, body: payload } };
  }

  const parsed = accountBookingResponseSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, failure: { kind: 'network' } };
  return { ok: true, data: parsed.data.booking };
}

/** Тело ответа как JSON; не-JSON ответ (пустое тело, HTML ошибки) — `null`. */
async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
