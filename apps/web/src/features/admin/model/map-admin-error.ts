import { apiErrorSchema } from '@hair-lab/contracts';
import type { AdminFailure } from '../api/admin-api';

/**
 * Разбор ошибки админки в текст для сотрудника.
 *
 * Тексты формируются здесь, а не берутся из ответа API: сообщения API технические
 * (в том числе из Zod) и в интерфейс не попадают. Это же гарантия ПДн — в подсказках нет
 * ни телефона клиента, ни адреса почты сотрудника, только объяснение, что произошло.
 *
 * Различаем сценарии, в которых действие сотрудника разное:
 * - `401` — сессия кончилась, нужен повторный вход;
 * - `404` — записи нет (уже отменили в другой вкладке), строку надо убрать;
 * - `409` — состояние записи изменилось, список надо перечитать;
 * - `429` — сработало ограничение попыток входа;
 * - сеть/`502`/`503` — сервис недоступен, имеет смысл повторить позже.
 */

/** Код ошибки API, если тело пришло по контракту. */
function errorCode(failure: Extract<AdminFailure, { kind: 'http' }>): string | null {
  const parsed = apiErrorSchema.safeParse(failure.body);
  return parsed.success ? parsed.data.error.code : null;
}

/** Ошибка загрузки дня или действия над записью. */
export function mapAdminError(failure: AdminFailure): string {
  if (failure.kind === 'network') return 'Сервис временно недоступен. Попробуйте позже.';

  const code = errorCode(failure);

  if (failure.status === 401 || code === 'unauthorized') {
    return 'Сессия истекла. Войдите снова.';
  }
  if (failure.status === 403 || code === 'forbidden') {
    return 'Недостаточно прав для этого действия.';
  }
  if (failure.status === 404 || code === 'not_found') {
    return 'Запись не найдена: возможно, её уже отменили. Список обновлён.';
  }
  if (failure.status === 409 || code === 'conflict') {
    return 'Действие невозможно: запись уже изменилась. Список обновляется — проверьте статус.';
  }
  if (failure.status === 429 || code === 'rate_limited') {
    return 'Слишком много запросов. Подождите минуту и попробуйте снова.';
  }
  if (failure.status === 502 || failure.status === 503) {
    return 'Сервис временно недоступен. Попробуйте позже.';
  }
  return 'Не удалось выполнить запрос. Попробуйте позже.';
}

/**
 * Ошибка входа сотрудника. Отдельно от `mapAdminError`: `401` при входе значит «неверные
 * данные», а не «сессия истекла», и текст не должен намекать, существует ли учётная запись
 * (API намеренно отвечает одинаково на неизвестную почту и неверный пароль).
 */
export function mapStaffLoginError(failure: AdminFailure): string {
  if (failure.kind === 'network') return 'Сервис временно недоступен. Попробуйте позже.';

  const code = errorCode(failure);

  if (failure.status === 400 || code === 'validation_error') {
    return 'Проверьте адрес почты и пароль.';
  }
  if (failure.status === 401 || code === 'unauthorized') {
    return 'Неверный email или пароль.';
  }
  if (failure.status === 403 || code === 'forbidden') {
    return 'Доступ к админке закрыт. Обратитесь к администратору салона.';
  }
  if (failure.status === 429 || code === 'rate_limited') {
    return 'Слишком много попыток. Подождите минуту и попробуйте снова.';
  }
  return 'Не удалось выполнить запрос. Попробуйте позже.';
}
