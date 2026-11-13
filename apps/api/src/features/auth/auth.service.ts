import type { ClientAccount, LoginRequest, RegisterRequest } from '@hair-lab/contracts';
import { createSession, revokeSession, type AuthClient } from '../../shared/auth';
import { hashPassword, verifyDummyPassword, verifyPassword } from '../../shared/auth/password';
import { sqlStateOf, type Db } from '../../shared/db';
import { issueMagicLinkInTransaction } from './magic-link.service';
import type { TokenDeliveryRegistry } from './token-delivery';

/** Адрес уже занят: 409 `conflict`. */
export class EmailTakenError extends Error {
  readonly statusCode = 409;

  constructor() {
    super('Не удалось создать аккаунт: проверьте данные и попробуйте войти');
    this.name = 'EmailTakenError';
  }
}

/** Неверные учётные данные или неподтверждённая почта — нейтральный 401. */
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

/**
 * Create account, registration session and verification outbox event atomically.
 * A duplicate address is rejected with `EmailTakenError` (409) before any session is issued.
 */
export async function registerClient(
  db: Db,
  dto: RegisterRequest,
  delivery: TokenDeliveryRegistry,
): Promise<AuthResult> {
  const passwordHash = await hashPassword(dto.password);
  let issued: Awaited<ReturnType<typeof issueMagicLinkInTransaction>> | undefined;

  try {
    const result = await db.$transaction(async (tx) => {
      const client = await tx.client.create({
        data: { email: dto.email, passwordHash },
        select: { id: true, email: true, emailVerifiedAt: true },
      });
      const { token } = await createSession(tx, client.id);
      issued = await issueMagicLinkInTransaction(tx, client, delivery);
      return { client, token };
    });
    if (issued === undefined) throw new Error('verification token was not issued');
    for (const id of issued.supersededIds) delivery.remove(id);
    return { client: toClientAccount(result.client), token: result.token };
  } catch (error) {
    if (issued !== undefined) delivery.remove(issued.loginTokenId);
    // 23505 (Postgres) или P2002 (Prisma) — адрес уже занят. Окончательный ответ даёт
    // уникальный индекс на `clients.email`, поэтому гонка «найти, потом создать» исключена.
    if (sqlStateOf(error) === '23505' || (error as { code?: string }).code === 'P2002') {
      throw new EmailTakenError();
    }
    throw error;
  }
}

/** Password login remains unavailable until the email has been verified by a link. */
export async function loginClient(db: Db, dto: LoginRequest): Promise<AuthResult> {
  const client = await db.client.findUnique({
    where: { email: dto.email },
    select: { id: true, email: true, emailVerifiedAt: true, passwordHash: true },
  });

  if (client === null || client.passwordHash === null) {
    await verifyDummyPassword(dto.password);
    throw new InvalidCredentialsError();
  }
  if (
    !(await verifyPassword(client.passwordHash, dto.password)) ||
    client.emailVerifiedAt === null
  ) {
    throw new InvalidCredentialsError();
  }

  const { token } = await createSession(db, client.id);
  return { client: toClientAccount(client), token };
}

/** Выход: удаляет сессию по токену. Отсутствие сессии не ошибка. */
export async function logoutClient(db: Db, token: string): Promise<void> {
  await revokeSession(db, token);
}
