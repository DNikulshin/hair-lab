/**
 * Ключ идемпотентности гостевой записи.
 *
 * Ключ создаётся один раз на попытку записи (в момент выбора слота) и живёт до успешного
 * ответа API. Повторная отправка после сетевой ошибки идёт с тем же ключом: если первая
 * попытка всё-таки дошла до сервера, клиент получит уже созданную запись (200), а не дубль.
 * Новый ключ — только когда пользователь меняет слот: это уже другая попытка.
 *
 * Ключ не содержит персональных данных и не является секретом: сервер использует его
 * как маркер запроса и хранит в БД рядом с записью.
 */

/** Минимальная длина ключа по контракту (`idempotencyKeySchema`). */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;

/** Максимальная длина ключа по контракту (`idempotencyKeySchema`). */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Случайная часть: `crypto.randomUUID` в браузере и Node 22, иначе запасной вариант. */
function randomPart(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return Math.random().toString(36).slice(2, 14);
}

/**
 * Ключ вида `guest-<время в base36>-<случайная часть>`: сортируемый по времени,
 * уникальный и укладывающийся в лимиты контракта.
 * Параметры вынесены для тестов; в коде вызывается без аргументов.
 */
export function createIdempotencyKey(
  now: number = Date.now(),
  random: () => string = randomPart,
): string {
  return `guest-${now.toString(36)}-${random()}`;
}
