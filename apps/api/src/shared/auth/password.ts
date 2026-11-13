import { hash, verify } from '@node-rs/argon2';
import type { Algorithm } from '@node-rs/argon2';

/**
 * Хеширование паролей клиентов.
 *
 * Алгоритм — argon2id с параметрами OWASP-рекомендации «второй вариант»
 * (m=19456 KiB, t=2, p=1): устойчив к GPU-подбору и к атакам по сторонним каналам,
 * при этом один хеш занимает ~19 МиБ и считается десятки миллисекунд — это приемлемо
 * для входа и регистрации. Параметры записаны в самой PHC-строке, поэтому их смена
 * не ломает проверку старых хешей.
 *
 * Пароль в логи не попадает: значения в текстах ошибок не выводятся, `verify` возвращает
 * только булево значение.
 */

/** Параметры argon2id. Менять только осознанно: они влияют на стойкость и стоимость входа. */
export const ARGON2_OPTIONS = {
  // The package exports Algorithm as an ambient const enum; use its stable native value
  // without inlining the const enum across verbatimModuleSyntax package boundaries.
  algorithm: 2 as Algorithm,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Валидный argon2id-хеш вымышленного пароля. Нужен для выравнивания времени ответа:
 * на неизвестный email выполняется проверка против этой заглушки, и по времени ответа
 * нельзя понять, существует ли аккаунт.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$fP99nY3K8qAMye1HfZgWMw$e13Ky0rja36bc5/PCbVO2PUbfrvb0ENy9jt/T49VS84';

/** Хеш пароля в формате PHC (`$argon2id$v=19$m=…,t=…,p=…$salt$hash`). */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * Проверка пароля по сохранённому хешу. Битый или чужой формат хеша — `false`,
 * а не исключение: испорченная строка в БД не должна ронять обработчик входа.
 */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Фиктивная проверка пароля против заглушки: используется, когда email неизвестен,
 * чтобы вход отвечал за сопоставимое время и не выдавал наличие аккаунта.
 */
export async function verifyDummyPassword(password: string): Promise<void> {
  await verifyPassword(DUMMY_PASSWORD_HASH, password);
}
