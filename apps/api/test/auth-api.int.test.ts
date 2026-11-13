import { randomUUID } from 'node:crypto';
import { apiErrorSchema, authResponseSchema } from '@hair-lab/contracts';
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

async function register(address = email(), ip = nextIp()) {
  return app.inject({
    method: 'POST',
    url: '/auth/register',
    headers: headers(ip),
    payload: { email: address, password },
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
  it('registers an account, establishes /auth/me session and clears it on logout', async () => {
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

    const cookie = sessionCookie(registered);
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { ...headers(), cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(accountId(me.json())).toBe(id);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: headers(),
      payload: { email: address, password },
    });
    expect(login.statusCode).toBe(200);
    expect(accountId(login.json())).toBe(id);
    const loginCookie = sessionCookie(login);
    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { ...headers(), cookie: loginCookie },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    const unauthorized = await app.inject({ method: 'GET', url: '/auth/me', headers: headers() });
    expect(unauthorized.statusCode).toBe(401);
    expect(apiErrorSchema.parse(unauthorized.json()).error.code).toBe('unauthorized');
  });

  it('returns neutral 409 for duplicate email and identical 401 for unknown and wrong passwords', async () => {
    const address = email();
    const first = await register(address);
    fixture.trackClient(accountId(first.json()));
    const duplicate = await register(address);
    expect(duplicate.statusCode).toBe(409);
    expect(apiErrorSchema.parse(duplicate.json()).error.code).toBe('conflict');
    expect(duplicate.body.toLowerCase()).not.toContain('email');

    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: headers(),
      payload: { email: address, password: 'wrong password sample' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: headers(),
      payload: { email: email(), password },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(apiErrorSchema.parse(wrong.json()).error.code).toBe('unauthorized');
    expect(apiErrorSchema.parse(unknown.json()).error.code).toBe('unauthorized');
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
