import { proxyToApi } from '@/shared/api/route-proxy';

/**
 * `GET /api/staff/me` — текущий сотрудник.
 *
 * Сессии в браузере нет — cookie уходит наверх сама, а API отвечает 401, если сессии нет
 * или сотрудник деактивирован. Прокси пробрасывает статус как есть: по 401 экран админки
 * показывает форму входа, а не пустой список дня. Ответ с почтой сотрудника не кэшируется
 * (`Cache-Control: no-store` ставит прокси).
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return proxyToApi('/staff/me', {}, request);
}
