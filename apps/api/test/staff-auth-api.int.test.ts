import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { apiErrorSchema, staffAuthResponseSchema, type StaffRole } from '@hair-lab/contracts';
import { buildServer } from '../src/app/build-server';
import { hashPassword } from '../src/shared/auth/password';
import { makeRequireStaff } from '../src/shared/auth/plugin';
import { hashToken } from '../src/shared/auth/tokens';
import { createFixture, createTestDb } from './db/helpers';

/**
 * Вход сотрудника в админку (issue #240): отдельная cookie `hl_staff_session`, отдельные сессии.
 *
 * Роут с ограничением по роли в план #240 не входит (RBAC — отдельная задача), поэтому
 * проверка 403 идёт на пробном маршруте с той же фабрикой `makeRequireStaff(['admin'])`:
 * плагин, cookie и резолв сессии при этом настоящие, придуманных продуктовых эндпоинтов нет.
 */
const db = createTestDb();
const fixture = createFixture(db);
const app: FastifyInstance = await buildServer();
await app.register(async (instance) => {
  instance.get(
    '/__test/staff-admin-only',
    { preHandler: makeRequireStaff(['admin']) },
    async () => ({ ok: true }),
  );
});

/** Вымышленные данные: реальных сотрудников, почт и паролей здесь нет. */
// Заглушка `example-…` по конвенции репозитория (см. health.routes.test.ts): иначе литерал
// похож на настоящий секрет и красит гейт `secrets_scan`.
const password = 'example-staff-password-0001';
const staffIds: string[] = [];
let ipNumber = 40;
function nextIp(): string {
  ipNumber += 1;
  return `10.1.${Math.floor(ipNumber / 250)}.${(ipNumber % 250) + 1}`;
}
const headers = (ip = nextIp()) => ({ 'x-forwarded-for': ip });
const email = () => `staff-${randomUUID()}@example.invalid`;

/** Сотрудник в БД: хеш argon2id от вымышленного пароля, роль и активность — параметрами. */
async function createStaff(
  overrides: { email?: string; role?: StaffRole; isActive?: boolean; password?: string } = {},
): Promise<{ id: string; email: string }> {
  const created = await db.staff.create({
    data: {
      email: overrides.email ?? email(),
      passwordHash: await hashPassword(overrides.password ?? password),
      role: overrides.role ?? 'manager',
      isActive: overrides.isActive ?? true,
    },
    select: { id: true, email: true },
  });
  staffIds.push(created.id);
  return created;
}

function sessionCookie(
  response: Awaited<ReturnType<typeof app.inject>>,
  name = 'hl_staff_session',
): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header.join(';') : (header ?? '');
  const match = value.match(new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`));
  if (!match?.[1]) throw new Error(`${name} cookie was not returned`);
  return `${name}=${match[1]}`;
}

async function login(address: string, ip = nextIp(), candidate = password) {
  return app.inject({
    method: 'POST',
    url: '/staff/auth/login',
    headers: headers(ip),
    payload: { email: address, password: candidate },
  });
}

afterEach(async () => {
  await fixture.cleanup();
  if (staffIds.length > 0) {
    // Сессии удаляются каскадом вместе с сотрудником.
    await db.staff.deleteMany({ where: { id: { in: staffIds } } });
    staffIds.length = 0;
  }
});

afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

describe('staff authentication API', () => {
  it('logs in with an httpOnly staffing cookie, returns /staff/me and logs out', async () => {
    const staff = await createStaff({ role: 'manager' });

    const response = await login(staff.email);

    expect(response.statusCode).toBe(200);
    const cookieHeader = response.headers['set-cookie'] ?? '';
    expect(cookieHeader).toContain('hl_staff_session=');
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('Path=/');
    expect(cookieHeader).toContain('SameSite=Lax');
    // Клиентская cookie при входе сотрудника не выдаётся.
    expect(cookieHeader).not.toContain('hl_session=');
    expect(staffAuthResponseSchema.parse(response.json()).staff).toEqual({
      id: staff.id,
      email: staff.email,
      role: 'manager',
    });
    // Ни пароля, ни argon2-хеша в ответе нет.
    expect(response.body).not.toContain(password);
    expect(response.body).not.toContain('$argon2id$');

    const cookie = sessionCookie(response);
    const me = await app.inject({
      method: 'GET',
      url: '/staff/me',
      headers: { ...headers(), cookie },
    });
    expect(me.statusCode).toBe(200);
    expect(staffAuthResponseSchema.parse(me.json()).staff.id).toBe(staff.id);

    // В БД сессия с хешем токена и сроком одного рабочего дня.
    const sessions = await db.$queryRaw<Array<{ token_hash: string; ttl_ms: number }>>`
      SELECT "token_hash", (EXTRACT(EPOCH FROM ("expires_at" - now())) * 1000)::int AS ttl_ms
      FROM "staff_sessions" WHERE "staff_id" = ${staff.id}::uuid
    `;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    // В cookie — сырой токен, в БД — его SHA-256: значения разные.
    expect(cookie).not.toContain(sessions[0]?.token_hash ?? 'never');
    const ttlHours = (sessions[0]?.ttl_ms ?? 0) / 3_600_000;
    expect(ttlHours).toBeGreaterThan(7.5);
    expect(ttlHours).toBeLessThanOrEqual(8);

    const logout = await app.inject({
      method: 'POST',
      url: '/staff/auth/logout',
      headers: { ...headers(), cookie },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');

    const afterLogout = await app.inject({
      method: 'GET',
      url: '/staff/me',
      headers: { ...headers(), cookie },
    });
    expect(afterLogout.statusCode).toBe(401);
    expect(apiErrorSchema.parse(afterLogout.json()).error.code).toBe('unauthorized');
    expect(await db.staffSession.count({ where: { staffId: staff.id } })).toBe(0);
  });

  it('normalises the email on login and gives one 401 for unknown email, wrong password and inactive staff', async () => {
    const active = await createStaff({ role: 'admin' });
    const inactive = await createStaff({ isActive: false });

    const mixedCase = await login(`  ${active.email.toUpperCase()} `);
    expect(mixedCase.statusCode).toBe(200);

    const unknown = await login(email());
    const wrongPassword = await login(active.email, nextIp(), 'wrong-password-0002');
    const deactivated = await login(inactive.email);

    for (const rejected of [unknown, wrongPassword, deactivated]) {
      expect(rejected.statusCode).toBe(401);
      expect(apiErrorSchema.parse(rejected.json()).error.code).toBe('unauthorized');
      expect(rejected.headers['set-cookie']).toBeUndefined();
    }
    // Тело ответа одинаковое (кроме идентификатора запроса): наличие и активность
    // учётной записи не раскрываются.
    const body = (response: { json: () => unknown }) => {
      const { error } = apiErrorSchema.parse(response.json());
      return { code: error.code, message: error.message };
    };
    expect(body(unknown)).toEqual(body(wrongPassword));
    expect(body(wrongPassword)).toEqual(body(deactivated));
    // Отклонённый вход без пароля не создаёт сессию деактивированному сотруднику.
    expect(await db.staffSession.count({ where: { staffId: inactive.id } })).toBe(0);
  });

  it('keeps a deactivated employee out of the admin routes with an existing session', async () => {
    const staff = await createStaff({ role: 'admin' });
    const cookie = sessionCookie(await login(staff.email));

    const before = await app.inject({
      method: 'GET',
      url: '/staff/me',
      headers: { ...headers(), cookie },
    });
    expect(before.statusCode).toBe(200);

    await db.staff.update({ where: { id: staff.id }, data: { isActive: false } });

    const after = await app.inject({
      method: 'GET',
      url: '/staff/me',
      headers: { ...headers(), cookie },
    });
    expect(after.statusCode).toBe(401);
    expect(apiErrorSchema.parse(after.json()).error.code).toBe('unauthorized');
  });

  it('rejects an expired staff session and clears the cookie without extending it', async () => {
    const staff = await createStaff();
    const expiredToken = `expired-staff-token-${randomUUID()}`;
    await db.$executeRaw`
      INSERT INTO "staff_sessions" ("id", "token_hash", "staff_id", "expires_at", "last_used_at")
      VALUES (
        ${randomUUID()}::uuid,
        ${hashToken(expiredToken)},
        ${staff.id}::uuid,
        now() - interval '1 minute',
        now() - interval '9 hours'
      )
    `;

    const response = await app.inject({
      method: 'GET',
      url: '/staff/me',
      headers: { ...headers(), cookie: `hl_staff_session=${expiredToken}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toContain('hl_staff_session=;');
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
    // Просроченная строка удалена, продления не было.
    expect(await db.staffSession.count({ where: { staffId: staff.id } })).toBe(0);
  });

  it('does not accept the client cookie on staff routes and vice versa', async () => {
    const staff = await createStaff({ role: 'admin' });
    const staffCookie = sessionCookie(await login(staff.email));

    const clientId = await fixture.client(`client-${randomUUID()}@example.invalid`);
    const clientCookie = `hl_session=${await fixture.session(clientId)}`;

    const withClientCookie = await app.inject({
      method: 'GET',
      url: '/staff/me',
      headers: { ...headers(), cookie: clientCookie },
    });
    expect(withClientCookie.statusCode).toBe(401);
    expect(apiErrorSchema.parse(withClientCookie.json()).error.code).toBe('unauthorized');

    const withStaffCookie = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { ...headers(), cookie: staffCookie },
    });
    expect(withStaffCookie.statusCode).toBe(401);

    // Обе cookie сразу: каждая открывает только свои маршруты.
    const both = await app.inject({
      method: 'GET',
      url: '/staff/me',
      headers: { ...headers(), cookie: `${clientCookie}; ${staffCookie}` },
    });
    expect(both.statusCode).toBe(200);
  });

  it('forbids a role outside the allowed list on a role-restricted route', async () => {
    const manager = await createStaff({ role: 'manager' });
    const admin = await createStaff({ role: 'admin' });

    const managerCookie = sessionCookie(await login(manager.email));
    const adminCookie = sessionCookie(await login(admin.email));

    const forbidden = await app.inject({
      method: 'GET',
      url: '/__test/staff-admin-only',
      headers: { ...headers(), cookie: managerCookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(apiErrorSchema.parse(forbidden.json()).error.code).toBe('forbidden');

    const allowed = await app.inject({
      method: 'GET',
      url: '/__test/staff-admin-only',
      headers: { ...headers(), cookie: adminCookie },
    });
    expect(allowed.statusCode).toBe(200);

    const anonymous = await app.inject({
      method: 'GET',
      url: '/__test/staff-admin-only',
      headers: headers(),
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('limits staff logins to ten attempts per minute for each IP', async () => {
    const staff = await createStaff();
    const ip = nextIp();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await login(staff.email, ip, 'wrong-password-0002');
      expect(response.statusCode).toBe(401);
    }
    const limited = await login(staff.email, ip);
    expect(limited.statusCode).toBe(429);
    expect(apiErrorSchema.parse(limited.json()).error.code).toBe('rate_limited');
    expect(limited.headers['set-cookie']).toBeUndefined();
  });

  it('rejects an untrusted Origin on staff login and logout (CSRF)', async () => {
    const staff = await createStaff();
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/staff/auth/login',
      headers: { ...headers(), origin: 'https://attacker.example.invalid' },
      payload: { email: staff.email, password },
    });
    expect(loginResponse.statusCode).toBe(403);
    expect(apiErrorSchema.parse(loginResponse.json()).error.code).toBe('forbidden');

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/staff/auth/logout',
      headers: { ...headers(), origin: 'https://attacker.example.invalid' },
    });
    expect(logoutResponse.statusCode).toBe(403);
    expect(apiErrorSchema.parse(logoutResponse.json()).error.code).toBe('forbidden');
  });

  it('validates the login body with the contract', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/staff/auth/login',
      headers: headers(),
      payload: { email: 'not-an-email', password: 'x' },
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('validation_error');
  });
});
