import { createBookingSchema } from '@hair-lab/contracts';
import { jsonErrorResponse, proxyToApi } from '@/shared/api/route-proxy';

/**
 * `POST /api/bookings` — создание гостевой записи.
 *
 * Тело проверяется той же схемой, что и в API (контракт — источник истины), и только потом
 * уходит наверх: клиент получает 400 с `details` по полям, не дожидаясь сети. Нормализация
 * телефона в E.164 происходит в схеме — API и БД получают уже канонический номер.
 *
 * Тело запроса содержит телефон клиента: в логи оно не попадает, тексты ошибок валидации
 * не повторяют введённые значения.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonErrorResponse(400, 'validation_error', 'Некорректный JSON в теле запроса');
  }

  const parsed = createBookingSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    return jsonErrorResponse(400, 'validation_error', 'Проверьте данные записи', details);
  }

  return proxyToApi('/bookings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(parsed.data),
  });
}
