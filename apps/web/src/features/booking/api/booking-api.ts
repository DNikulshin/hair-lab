import {
  bookingResponseSchema,
  type Booking,
  type CreateBooking,
  type Slot,
} from '@hair-lab/contracts';
import type { BookingFailure } from '../model/map-booking-error';
import { parseSlotsPayload } from '../model/slots-model';

/**
 * Запросы формы записи из браузера.
 *
 * Ходим только в same-origin Route Handlers web (`/api/slots`, `/api/bookings`):
 * они проксируют запрос во внутренний адрес API и пробрасывают статус. Прямой вызов API
 * из браузера потребовал бы CORS, которого в API сознательно нет.
 *
 * Ответы валидируются контрактом (`safeParse`): невалидный payload — «сервис недоступен»,
 * а не молчаливая пустота. Телефон уходит только в теле POST и никуда не логируется.
 */

export interface SlotsRequest {
  serviceId: string;
  date: string;
  /** Не задан — слоты всех мастеров, оказывающих услугу. */
  masterId?: string;
}

export type SlotsResult =
  | { ok: true; slots: Slot[] }
  | {
      ok: false;
      /** `true` — сервис недоступен (сеть, 502/503, ответ не по контракту). */
      unavailable: boolean;
    };

export type SubmitBookingResult =
  { ok: true; booking: Booking } | { ok: false; failure: BookingFailure };

/** Свободные слоты на дату. `signal` — отмена запроса при смене даты/мастера. */
export async function fetchSlots(params: SlotsRequest, signal?: AbortSignal): Promise<SlotsResult> {
  const search = new URLSearchParams({ serviceId: params.serviceId, date: params.date });
  if (params.masterId !== undefined) search.set('masterId', params.masterId);

  let response: Response;
  try {
    response = await fetch(`/api/slots?${search.toString()}`, { signal, cache: 'no-store' });
  } catch {
    return { ok: false, unavailable: true };
  }

  if (response.status === 502 || response.status === 503) {
    return { ok: false, unavailable: true };
  }
  if (!response.ok) return { ok: false, unavailable: false };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, unavailable: true };
  }

  const slots = parseSlotsPayload(payload);
  if (slots === null) return { ok: false, unavailable: true };

  return { ok: true, slots };
}

/**
 * Создание записи. Идемпотентность обеспечивает `idempotencyKey` в теле:
 * повторная отправка того же ключа вернёт уже созданную запись.
 */
export async function submitBooking(body: CreateBooking): Promise<SubmitBookingResult> {
  let response: Response;
  try {
    response = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, failure: { kind: 'network' } };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (response.ok) {
    const parsed = bookingResponseSchema.safeParse(payload);
    // 2xx с невалидным телом считаем недоступностью сервиса: запись могла создаться,
    // но показать её нечем. Повтор с тем же ключом безопасен и вернёт ту же запись.
    if (!parsed.success) return { ok: false, failure: { kind: 'network' } };
    return { ok: true, booking: parsed.data.booking };
  }

  return { ok: false, failure: { kind: 'http', status: response.status, body: payload } };
}
