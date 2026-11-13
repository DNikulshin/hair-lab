import { randomUUID } from 'node:crypto';
import { apiErrorSchema, authResponseSchema } from '@hair-lab/contracts';
import { hashPassword } from '../src/shared/auth/password';
import { hashToken } from '../src/shared/auth/tokens';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/app/build-server';
import { createFixture, createTestDb } from './db/helpers';

const db = createTestDb();
const fixture = createFixture(db);
const app = await buildServer();
let ipNumber = 10;
function nextIp(): string {
  ipNumber += 1;
  return `10.0.${Math.floor(ipNumber / 250)}.${(ipNumber % 250) + 1}`;
}
const headers = (ip = nextIp()) => ({ 'x-forwarded-for': ip });
const email = () => `client-${randomUUID()}@example.invalid`;
const password = 'correct horse battery';

function sessionCookie(response: Awaited<ReturnType<typeof app.inject>>): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header.join(';') : (header ?? '');
  const match = value.match(/(?:^|,\s*)hl_session=([^;,]+)/);
  if (!match?.[1]) throw new Error('session cookie was not returned');
  return `hl_session=${match[1]}`;
}

function accountId(body: unknown): string {
  return authResponseSchema.parse(body).client.id;
}

async function trackMagicOutbox(address: string): Promise<void> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "outbox_messages"
    WHERE "type" = 'magic_link' AND "payload"->>'email' = ${address}
  `;
  rows.forEach(({ id }) => fixture.trackOutbox(id));
}

async function register(address = email(), ip = nextIp()) {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/register',
    headers: headers(ip),
    payload: { email: address, password },
  });
  await trackMagicOutbox(address);
  return response;
}

async function insertToken(
  clientId: string,
  token = `synthetic-token-${randomUUID()}`,
  expiresAt = new Date(Date.now() + 15 * 60_000),
): Promise<string> {
  await db.$executeRaw`
    INSERT INTO "login_tokens" ("id", "token_hash", "client_id", "expires_at")
    VALUES (${randomUUID()}::uuid, ${hashToken(token)}, ${clientId}::uuid, ${expiresAt})
  `;
  return token;
}

async function consume(token: string) {
  return app.inject({
    method: 'POST',
    url: '/auth/magic-link/consume',
    headers: headers(),
    payload: { token },
  });
}

afterEach(async () => {
  await fixture.cleanup();
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

describe('client authentication API', () => {
  it('keeps the registration session, sends a token-free outbox payload and gates password login', async () => {
    const address = email();
    const registered = await register(address);
    expect(registered.statusCode).toBe(201);
    const id = accountId(registered.json());
    fixture.trackClient(id);
    expect(registered.headers['set-cookie']).toContain('hl_session=');
    expect(registered.headers['set-cookie']).toContain('HttpOnly');
    expect(registered.headers['set-cookie']).toContain('Path=/');
    expect(registered.body).not.toContain(password);
    expect(registered.body).not.toContain('token');
    expect(authResponseSchema.parse(registered.json()).client.emailVerifiedAt).toBeNull();
    const verifiedAt = await db.$queryRaw<Array<{ email_verified_at: Date | null }>>`
      SELECT "email_verified_at" FROM "clients" WHERE "id" = ${id}::uuid
    `;
    expect(verifiedAt).toHaveLength(1);
    expect(verifiedAt[0]?.email_verified_at).toBeNull();

    const payloads = await db.$queryRaw<Array<{ payload: unknown }>>`
      SELECT "payload" FROM "outbox_messages"
      WHERE "type" = 'magic_link' AND "payload"->>'email' = ${address}
    `;
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.payload).toMatchObject({ email: address });
    expect(Object.keys(payloads[0]?.payload as Record<string, unknown>).sort()).toEqual([
      'email',
      'loginTokenId',
    ]);

    const cookie = sessionCookie(registered);
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { ...headers(), cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(accountId(me.json())).toBe(id);

    const blockedLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: headers(),
      payload: { email: address, password },
    });
    expect(blockedLogin.statusCode).toBe(401);
    expect(apiErrorSchema.parse(blockedLogin.json()).error.code).toBe('unauthorized');

    const consumed = await consume(await insertToken(id));
    expect(consumed.statusCode).toBe(200);
    expect(consumed.headers['set-cookie']).toContain('hl_session=');
    expect(authResponseSchema.parse(consumed.json()).client.emailVerifiedAt).not.toBeNull();

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: headers(),
      payload: { email: address, password },
    });
    expect(login.statusCode).toBe(200);
    expect(accountId(login.json())).toBe(id);

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { ...headers(), cookie: sessionCookie(login) },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    const unauthorized = await app.inject({ method: 'GET', url: '/auth/me', headers: headers() });
    expect(unauthorized.statusCode).toBe(401);
  });

  it('rejects a duplicate email with 409 and issues neither a session nor a link', async () => {
    const address = email();
    const first = await register(address);
    const actualId = accountId(first.json());
    fixture.trackClient(actualId);

    const duplicate = await register(address);
    expect(duplicate.statusCode).toBe(409);
    expect(apiErrorSchema.parse(duplicate.json()).error.code).toBe('conflict');
    expect(duplicate.headers['set-cookie']).toBeUndefined();

    // Дубликат не создаёт новую ссылку и не гасит уже выданный владельцу токен.
    const messages = await db.$queryRaw<Array<{ id: string; payload: unknown }>>`
      SELECT "id", "payload" FROM "outbox_messages"
      WHERE "type" = 'magic_link' AND "payload"->>'email' = ${address}
    `;
    expect(messages).toHaveLength(1);

    const tokens = await db.$queryRaw<Array<{ consumed_at: Date | null }>>`
      SELECT "consumed_at" FROM "login_tokens" WHERE "client_id" = ${actualId}::uuid
    `;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.consumed_at).toBeNull();

    // Сессии не появилось: единственная сессия — от успешной регистрации.
    const sessions = await db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "sessions" WHERE "client_id" = ${actualId}::uuid
    `;
    expect(sessions).toHaveLength(1);
  });

  it('consumes a single token exactly once under concurrent requests', async () => {
    const clientId = await fixture.client(email());
    const token = await insertToken(clientId);

    // Оба запроса стартуют одновременно; сериализует их блокировка строки клиента,
    // поэтому исход детерминирован: ровно один 200, второй получает 401.
    const [first, second] = await Promise.all([consume(token), consume(token)]);
    expect([first.statusCode, second.statusCode].sort((a, b) => a - b)).toEqual([200, 401]);

    const accepted = first.statusCode === 200 ? first : second;
    const rejected = first.statusCode === 200 ? second : first;
    expect(accepted.headers['set-cookie']).toContain('hl_session=');
    expect(apiErrorSchema.parse(rejected.json()).error.code).toBe('unauthorized');

    // Проигравший запрос не оставил следов: одна сессия и одно погашение токена.
    const sessions = await db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "sessions" WHERE "client_id" = ${clientId}::uuid
    `;
    expect(sessions).toHaveLength(1);
    const tokens = await db.$queryRaw<Array<{ consumed_at: Date | null }>>`
      SELECT "consumed_at" FROM "login_tokens" WHERE "client_id" = ${clientId}::uuid
    `;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.consumed_at).not.toBeNull();
  });

  it('invalidates the previous link when a new one is requested', async () => {
    const address = email();
    const clientId = await fixture.client(address);
    const oldToken = await insertToken(clientId);

    const issued = await app.inject({
      method: 'POST',
      url: '/auth/magic-link',
      headers: headers(),
      payload: { email: address },
    });
    expect(issued.statusCode).toBe(202);
    await trackMagicOutbox(address);

    const superseded = await consume(oldToken);
    expect(superseded.statusCode).toBe(401);
    expect(apiErrorSchema.parse(superseded.json()).error.code).toBe('unauthorized');

    const rows = await db.$queryRaw<Array<{ token_hash: string; consumed_at: Date | null }>>`
      SELECT "token_hash", "consumed_at" FROM "login_tokens"
      WHERE "client_id" = ${clientId}::uuid
    `;
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.token_hash === hashToken(oldToken))?.consumed_at).not.toBeNull();
    expect(rows.filter((row) => row.consumed_at === null)).toHaveLength(1);
  });

  it('keeps exactly one active link when a request races with a consume', async () => {
    const address = email();
    const clientId = await fixture.client(address);
    const oldToken = await insertToken(clientId);

    // Исход гонки зависит от того, кто первым возьмёт блокировку строки клиента,
    // но инвариант один: активной остаётся ровно одна ссылка.
    const [issued, consumed] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/auth/magic-link',
        headers: headers(),
        payload: { email: address },
      }),
      consume(oldToken),
    ]);
    await trackMagicOutbox(address);
    expect(issued.statusCode).toBe(202);
    expect([200, 401]).toContain(consumed.statusCode);
    if (consumed.statusCode === 401) {
      expect(apiErrorSchema.parse(consumed.json()).error.code).toBe('unauthorized');
    }

    const rows = await db.$queryRaw<Array<{ consumed_at: Date | null }>>`
      SELECT "consumed_at" FROM "login_tokens" WHERE "client_id" = ${clientId}::uuid
    `;
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.consumed_at === null)).toHaveLength(1);
  });

  it('consumes a link once, verifies the client and auto-links only matching guest bookings', async () => {
    const masterId = await fixture.master();
    const serviceId = await fixture.service();
    const appointmentId = await fixture.appointment(
      masterId,
      serviceId,
      '2030-01-01T10:00:00.000Z',
      '2030-01-01T11:00:00.000Z',
    );
    const address = 'guest@example.invalid';
    const clientId = await fixture.client(address, await hashPassword(password));
    const token = await insertToken(clientId);

    const first = await consume(token);
    expect(first.statusCode).toBe(200);
    expect(accountId(first.json())).toBe(clientId);
    expect(first.headers['set-cookie']).toContain('hl_session=');
    expect(authResponseSchema.parse(first.json()).client.emailVerifiedAt).not.toBeNull();

    const linked = await db.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
    expect(linked.clientId).toBe(clientId);

    const second = await consume(token);
    expect(second.statusCode).toBe(401);
    expect(apiErrorSchema.parse(second.json()).error.code).toBe('unauthorized');

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: headers(),
      payload: { email: address, password },
    });
    expect(login.statusCode).toBe(200);
  });

  it('rejects expired tokens and returns an anti-enumeration response for unknown emails', async () => {
    const clientId = await fixture.client(email());
    const expiredToken = await insertToken(
      clientId,
      `expired-token-${randomUUID()}`,
      new Date(Date.now() - 1_000),
    );
    const expired = await consume(expiredToken);
    expect(expired.statusCode).toBe(401);
    expect(apiErrorSchema.parse(expired.json()).error.code).toBe('unauthorized');

    const unknownEmail = email();
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/magic-link',
      headers: headers(),
      payload: { email: unknownEmail },
    });
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toEqual({ ok: true });
    const outbox = await db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "outbox_messages"
      WHERE "type" = 'magic_link' AND "payload"->>'email' = ${unknownEmail}
    `;
    expect(outbox).toHaveLength(0);
  });

  it('limits magic-link requests by email and IP and consumes superseded tokens', async () => {
    const address = email();
    const clientId = await fixture.client(address);
    const ip = nextIp();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/magic-link',
        headers: headers(ip),
        payload: { email: address },
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ ok: true });
      await trackMagicOutbox(address);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/auth/magic-link',
      headers: headers(ip),
      payload: { email: address },
    });
    expect(limited.statusCode).toBe(429);
    expect(apiErrorSchema.parse(limited.json()).error.code).toBe('rate_limited');

    const tokens = await db.$queryRaw<Array<{ consumed_at: Date | null; expires_at: Date }>>`
      SELECT "consumed_at", "expires_at" FROM "login_tokens"
      WHERE "client_id" = ${clientId}::uuid ORDER BY "created_at" ASC
    `;
    expect(tokens).toHaveLength(3);
    expect(tokens.filter(({ consumed_at }) => consumed_at !== null)).toHaveLength(2);
    const remainingMs = tokens[2]!.expires_at.getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(14 * 60_000);
    expect(remainingMs).toBeLessThanOrEqual(15 * 60_000);
  });

  it('rejects an untrusted Origin on state-changing requests', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { ...headers(), origin: 'https://attacker.example.invalid' },
    });
    expect(response.statusCode).toBe(403);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('forbidden');
  });

  it('limits registrations to five attempts per IP per hour', async () => {
    const ip = nextIp();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await register(email(), ip);
      expect(result.statusCode).toBe(201);
      fixture.trackClient(accountId(result.json()));
    }
    const limited = await register(email(), ip);
    expect(limited.statusCode).toBe(429);
    expect(apiErrorSchema.parse(limited.json()).error.code).toBe('rate_limited');
  });
});
