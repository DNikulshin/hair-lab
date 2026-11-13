import { randomUUID } from 'node:crypto';
import type { MagicLinkConsumeRequest } from '@hair-lab/contracts';
import type { Prisma } from '../../generated/prisma/client';
import { createSession, type AuthClient } from '../../shared/auth';
import { createSessionToken, hashToken } from '../../shared/auth/tokens';
import type { Db } from '../../shared/db';
import { MAGIC_LINK_TYPE } from './magic-link.email';
import type { TokenDeliveryRegistry } from './token-delivery';

/** Magic links expire after fifteen minutes. */
export const MAGIC_LINK_TTL_MS = 15 * 60_000;

interface ClientForLink {
  id: string;
  email: string;
}

interface IssuedMagicLink {
  loginTokenId: string;
  supersededIds: string[];
}

export interface MagicLinkConsumeResult {
  client: AuthClient;
  token: string;
}

export class InvalidMagicLinkError extends Error {
  readonly statusCode = 401;

  constructor() {
    super('Ссылка недействительна или срок её действия истёк');
    this.name = 'InvalidMagicLinkError';
  }
}

/** Insert the hashed token and outbox record in the caller's transaction. */
export async function issueMagicLinkInTransaction(
  tx: Prisma.TransactionClient,
  client: ClientForLink,
  delivery: TokenDeliveryRegistry,
  now = new Date(),
): Promise<IssuedMagicLink> {
  // Serialize concurrent requests for this account so exactly the newest link remains valid.
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "clients" WHERE "id" = ${client.id}::uuid FOR UPDATE
  `;
  const superseded = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "login_tokens"
    SET "consumed_at" = CURRENT_TIMESTAMP
    WHERE "client_id" = ${client.id}::uuid AND "consumed_at" IS NULL
    RETURNING "id"
  `;

  const loginTokenId = randomUUID();
  const rawToken = createSessionToken();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_MS);
  delivery.put(loginTokenId, { rawToken, expiresAt });

  try {
    await tx.$executeRaw`
      INSERT INTO "login_tokens" ("id", "token_hash", "client_id", "expires_at", "created_at")
      VALUES (
        ${loginTokenId}::uuid,
        ${hashToken(rawToken)},
        ${client.id}::uuid,
        ${expiresAt},
        ${now}
      )
    `;
    await tx.outboxMessage.create({
      data: {
        type: MAGIC_LINK_TYPE,
        payload: { email: client.email, loginTokenId },
      },
    });
  } catch (error) {
    delivery.remove(loginTokenId);
    throw error;
  }

  delivery.prune(now);
  return { loginTokenId, supersededIds: superseded.map(({ id }) => id) };
}

/** Request a link; unknown addresses produce the same successful response and no DB writes. */
export async function requestMagicLink(
  db: Db,
  email: string,
  delivery: TokenDeliveryRegistry,
): Promise<void> {
  const client = await db.client.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (client === null) {
    delivery.prune();
    return;
  }

  let issued: IssuedMagicLink | undefined;
  try {
    issued = await db.$transaction(async (tx) => {
      const created = await issueMagicLinkInTransaction(tx, client, delivery);
      issued = created;
      return created;
    });
  } catch (error) {
    if (issued !== undefined) delivery.remove(issued.loginTokenId);
    throw error;
  }
  for (const id of issued.supersededIds) delivery.remove(id);
}

/** Consume once, verify the email, auto-link guest appointments, and create a session atomically. */
export async function consumeMagicLink(
  db: Db,
  dto: MagicLinkConsumeRequest,
  delivery: TokenDeliveryRegistry,
): Promise<MagicLinkConsumeResult> {
  const now = new Date();
  let consumedTokenId: string | undefined;
  const result = await db.$transaction(async (tx) => {
    const tokenHash = hashToken(dto.token);
    const candidate = await tx.$queryRaw<Array<{ id: string; client_id: string }>>`
      SELECT "id", "client_id" FROM "login_tokens"
      WHERE "token_hash" = ${tokenHash}
        AND "consumed_at" IS NULL
        AND "expires_at" > CURRENT_TIMESTAMP
    `;
    const candidateRow = candidate[0];
    if (candidateRow === undefined) throw new InvalidMagicLinkError();

    // Use the same client-then-token lock order as link issuance to avoid deadlocks.
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "clients" WHERE "id" = ${candidateRow.client_id}::uuid FOR UPDATE
    `;
    const consumed = await tx.$queryRaw<Array<{ id: string; client_id: string }>>`
      UPDATE "login_tokens"
      SET "consumed_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${candidateRow.id}::uuid
        AND "token_hash" = ${tokenHash}
        AND "consumed_at" IS NULL
        AND "expires_at" > CURRENT_TIMESTAMP
      RETURNING "id", "client_id"
    `;
    const row = consumed[0];
    if (row === undefined) throw new InvalidMagicLinkError();
    consumedTokenId = row.id;

    const client = await tx.client.findUnique({
      where: { id: row.client_id },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    if (client === null) throw new InvalidMagicLinkError();

    const verifiedAt = client.emailVerifiedAt ?? now;
    if (client.emailVerifiedAt === null) {
      await tx.client.update({
        where: { id: client.id },
        data: { emailVerifiedAt: verifiedAt },
      });
    }
    await tx.$executeRaw`
      UPDATE "appointments"
      SET "client_id" = ${client.id}::uuid
      WHERE "client_id" IS NULL AND lower("client_email") = lower(${client.email})
    `;

    const { token } = await createSession(tx, client.id, now);
    return {
      client: { id: client.id, email: client.email, emailVerifiedAt: verifiedAt },
      token,
    };
  });

  if (consumedTokenId !== undefined) delivery.remove(consumedTokenId);
  return result;
}
