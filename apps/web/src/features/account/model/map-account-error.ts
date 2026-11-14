import { apiErrorSchema } from '@hair-lab/contracts';
import type { AccountFailure } from '../api/account-api';

/**
 * Разбор ошибки кабинета клиента в текст для человека.
 *
 * Тексты формируются здесь, а не берутся из ответа API: сообщения API технические
 * (в том числе из Zod) и в интерфейс не попадают. Это же гарантия ПДн — в подсказках
 * нет ни номера телефона, ни адреса почты, только объяснение, что произошло.
 *
 * Различаем сценарии, в которых действие пользователя разное:
 * - `401` — сессия кончилась, нужен повторный вход;
 * - `404` — записи нет или она не наша (API намеренно не различает);
 * - `409` — отменить уже нельзя: срок вышел или статус финальный;
 * - `502`/`503`/сеть — сервис недоступен, имеет смысл повторить позже.
 */

/** Код ошибки API, если тело пришло по контракту. */
function errorCode(failure: Extract<AccountFailure, { kind: 'http' }>): string | null {
  const parsed = apiErrorSchema.safeParse(failure.body);
  return parsed.success ? parsed.data.error.code : null;
}

export function mapAccountError(failure: AccountFailure): string {
  if (failure.kind === 'network') return 'Сервис временно недоступен. Попробуйте позже.';

  const code = errorCode(failure);

  if (failure.status === 401 || code === 'unauthorized') {
    return 'Сессия истекла. Войдите снова, чтобы увидеть свои записи.';
  }
  if (failure.status === 404 || code === 'not_found') {
    return 'Запись не найдена: возможно, её уже отменили. Обновите список.';
  }
  if (failure.status === 409 || code === 'conflict') {
    return 'Эту запись отменить уже нельзя: до визита меньше двух часов или визит завершён. Позвоните в салон.';
  }
  if (failure.status === 429 || code === 'rate_limited') {
    return 'Слишком много запросов. Подождите минуту и попробуйте снова.';
  }
  if (failure.status === 502 || failure.status === 503) {
    return 'Сервис временно недоступен. Попробуйте позже.';
  }
  return 'Не удалось выполнить запрос. Попробуйте позже.';
}
