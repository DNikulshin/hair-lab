import type { ClientAccount, LoginRequest, RegisterRequest } from '@hair-lab/contracts';
import { createSession, revokeSession, type AuthClient } from '../../shared/auth';
import { hashPassword, verifyDummyPassword, verifyPassword } from '../../shared/auth/password';
import { sqlStateOf, type Db } from '../../shared/db';

/**
 * Регистрация, вход и выход клиента.
 *
 * Правила, которые держит сервис:
 * - занятый адрес при регистрации — 409 `conflict` с нейтральным текстом
 *   (в PR1 письма нет, поэтому «мягкий» ответ отправителю письма невозможен);
 * - неизвестный email и неверный пароль дают одинаковый 401: разница только в том,
 *   что для неизвестного адреса выполняется фиктивная проверка пароля — время ответа
 *   не выдаёт наличие аккаунта;
 * - сессия создаётся на каждый вход; вход и выход не пишут email, пароль и токены в логи.
 *
 * Почта приходит уже нормализованной схемой контракта (`trim` + нижний регистр).
 */

/** Адрес уже занят: 409 `conflict`. */
export class EmailTakenError extends Error {
  readonly statusCode = 409;

  constructor() {
    super('Не удалось создать аккаунт: проверьте данные и попробуйте войти');
    this.name = 'EmailTakenError';
  }
}

/** Неверные учётные данные: 401 `unauthorized` (без указания, что именно неверно). */
export class InvalidCredentialsError extends Error {
  readonly statusCode = 401;

  constructor() {
    super('Неверная почта или пароль');
    this.name = 'InvalidCredentialsError';
  }
}

/** Успешная регистрация или вход: клиент для ответа и токен для cookie сессии. */
export interface AuthResult {
  client: ClientAccount;
  /** Токен сессии. Уходит только в httpOnly cookie и никуда не логируется. */
  token: string;
}

/** Строка клиента, достаточная для DTO. */
function toClientAccount(row: {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
}): ClientAccount {
  return {
    id: row.id,
    email: row.email,
    emailVerifiedAt: row.emailVerifiedAt === null ? null : row.emailVerifiedAt.toISOString(),
  };
}

/** Клиент текущей сессии в виде DTO (`GET /auth/me`). */
export function me(client: AuthClient): ClientAccount {
  return toClientAccount(client);
}

/** Регистрация: хеш пароля (argon2id), строка клиента и сессия. */
export async function registerClient(db: Db, dto: RegisterRequest): Promise<AuthResult> {
  const passwordHash = await hashPassword(dto.password);

  let client: { id: string; email: string; emailVerifiedAt: Date | null };
  try {
    client = await db.client.create({
      data: { email: dto.email, passwordHash },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
  } catch (error) {
    // 23505 (Postgres) или P2002 (Prisma) — адрес уже занят. Проверка «сначала найти,
    // потом создать» здесь не годится: между запросами возможна гонка, окончательный
    // ответ даёт уникальный индекс на `clients.email`.
    if (sqlStateOf(error) === '23505' || (error as { code?: string }).code === 'P2002') {
      throw new EmailTakenError();
    }
    throw error;
  }

  const { token } = await createSession(db, client.id);
  return { client: toClientAccount(client), token };
}

/** Вход по email и паролю. Неизвестный адрес обрабатывается как неверный пароль. */
export async function loginClient(db: Db, dto: LoginRequest): Promise<AuthResult> {
  const client = await db.client.findUnique({
    where: { email: dto.email },
    select: { id: true, email: true, emailVerifiedAt: true, passwordHash: true },
  });

  // Аккаунт без пароля (появился иначе, например после PR2) тоже считается «неверными данными».
  if (client === null || client.passwordHash === null) {
    await verifyDummyPassword(dto.password);
    throw new InvalidCredentialsError();
  }

  if (!(await verifyPassword(client.passwordHash, dto.password))) {
    throw new InvalidCredentialsError();
  }

  const { token } = await createSession(db, client.id);
  return { client: toClientAccount(client), token };
}

/** Выход: удаляет сессию по токену. Отсутствие сессии не ошибка. */
export async function logoutClient(db: Db, token: string): Promise<void> {
  await revokeSession(db, token);
}
