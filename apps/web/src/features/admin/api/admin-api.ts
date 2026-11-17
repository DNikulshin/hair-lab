import {
  adminAppointmentResponseSchema,
  adminAppointmentsResponseSchema,
  okResponseSchema,
  staffAuthResponseSchema,
  type AdminAppointment,
  type AdminAppointmentsResponse,
  type StaffAccount,
  type StaffLoginRequest,
} from '@hair-lab/contracts';
import { withBasePath } from '@/shared/config/api';

/**
 * Запросы админки из браузера.
 *
 * Ходим только в same-origin Route Handlers web (`/api/staff/*`, `/api/admin/*`): они
 * проксируют запрос во внутренний API и пробрасывают статус (CORS в API сознательно нет).
 * Cookie сотрудника `hl_staff_session` — httpOnly, её ставит и снимает API через прокси;
 * в JS и в `localStorage` сессии нет.
 *
 * Ответы валидируются контрактом (`safeParse`): невалидный payload — «сервис недоступен»,
 * а не пустой список. Пустой день и сбой выглядят по-разному — путать их нельзя.
 *
 * ПДн: тело запроса (почта, пароль, причина отмены) и тело ответа никогда не логируются;
 * `no-store` ставит и прокси, и сам запрос.
 */

/** Причина неуспеха: HTTP-ответ API (тело уже разобрано) или отсутствие связи. */
export type AdminFailure = { kind: 'network' } | { kind: 'http'; status: number; body: unknown };

export type AdminResult<T> = { ok: true; data: T } | { ok: false; failure: AdminFailure };

/** Действия над записью: те же имена, что в путях API. */
export type AdminAction = 'confirm' | 'complete' | 'no-show' | 'cancel';

/** Ответ как JSON; не-JSON (пустое тело, HTML ошибки) — `null`. */
async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Запрос в свой Route Handler: сетевой сбой отделён от HTTP-статуса. */
async function send(path: string, init: RequestInit): Promise<AdminResult<unknown>> {
  let response: Response;
  try {
    response = await fetch(withBasePath(path), { ...init, cache: 'no-store' });
  } catch {
    return { ok: false, failure: { kind: 'network' } };
  }

  const payload = await readPayload(response);
  if (!response.ok) {
    return { ok: false, failure: { kind: 'http', status: response.status, body: payload } };
  }
  return { ok: true, data: payload };
}

/** Вход сотрудника. Пароль уходит только в теле POST и никуда не сохраняется. */
export async function loginStaff(
  credentials: StaffLoginRequest,
): Promise<AdminResult<StaffAccount>> {
  const result = await send('/api/staff/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  if (!result.ok) return result;

  const parsed = staffAuthResponseSchema.safeParse(result.data);
  if (!parsed.success) return { ok: false, failure: { kind: 'network' } };
  return { ok: true, data: parsed.data.staff };
}

/** Текущий сотрудник (`GET /api/staff/me`): `401` — сессии нет. */
export async function fetchCurrentStaff(): Promise<AdminResult<StaffAccount>> {
  const result = await send('/api/staff/me', {});
  if (!result.ok) return result;

  const parsed = staffAuthResponseSchema.safeParse(result.data);
  if (!parsed.success) return { ok: false, failure: { kind: 'network' } };
  return { ok: true, data: parsed.data.staff };
}

/** Выход: API удаляет сессию и снимает cookie. */
export async function logoutStaff(): Promise<AdminResult<true>> {
  const result = await send('/api/staff/auth/logout', { method: 'POST' });
  if (!result.ok) return result;

  const parsed = okResponseSchema.safeParse(result.data);
  if (!parsed.success) return { ok: false, failure: { kind: 'network' } };
  return { ok: true, data: true };
}

/** Записи одного дня в часовом поясе салона. */
export async function fetchAdminAppointments(
  date: string,
): Promise<AdminResult<AdminAppointmentsResponse>> {
  const result = await send(`/api/admin/appointments?date=${encodeURIComponent(date)}`, {});
  if (!result.ok) return result;

  const parsed = adminAppointmentsResponseSchema.safeParse(result.data);
  if (!parsed.success) return { ok: false, failure: { kind: 'network' } };
  return { ok: true, data: parsed.data };
}

/**
 * Действие над записью. Ответ — обновлённая запись: экран правит строку локально,
 * без повторной загрузки списка. Повтор уже выполненного действия идемпотентен (200).
 * Для отмены причина обязательна — её проверяет и экран, и API.
 */
export async function runAdminAction(
  id: string,
  action: AdminAction,
  reason?: string,
): Promise<AdminResult<AdminAppointment>> {
  const path = `/api/admin/appointments/${encodeURIComponent(id)}/${action}`;
  const init: RequestInit =
    action === 'cancel'
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: reason ?? '' }),
        }
      : { method: 'POST' };

  const result = await send(path, init);
  if (!result.ok) return result;

  const parsed = adminAppointmentResponseSchema.safeParse(result.data);
  if (!parsed.success) return { ok: false, failure: { kind: 'network' } };
  return { ok: true, data: parsed.data.booking };
}
