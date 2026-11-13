import { apiErrorSchema } from '@hair-lab/contracts';
import type { AuthFailure } from '../api/auth-api';

/** Только нейтральные сообщения: текст сервера и пользовательские значения не отображаются. */
export function mapAuthError(failure: AuthFailure): string {
  if (failure.kind === 'network') return 'Сервис временно недоступен. Попробуйте позже.';
  const parsed = apiErrorSchema.safeParse(failure.body);
  const code = parsed.success ? parsed.data.error.code : null;

  if (failure.status === 400) return 'Проверьте адрес почты и пароль.';
  if (failure.status === 401 || code === 'unauthorized') return 'Неверная почта или пароль.';
  if (failure.status === 409 || code === 'conflict') {
    return 'Не удалось создать аккаунт. Проверьте данные или войдите.';
  }
  if (failure.status === 429 || code === 'rate_limited') {
    return 'Слишком много попыток. Подождите и попробуйте снова.';
  }
  return 'Не удалось выполнить запрос. Попробуйте позже.';
}
