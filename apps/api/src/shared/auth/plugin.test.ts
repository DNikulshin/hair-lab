import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { makeRequireStaff, STAFF_SESSION_COOKIE_NAME, SESSION_COOKIE_NAME } from './plugin';
import type { AuthStaff } from './staff-session';

/** Минимальная заглушка ответа: фиксирует статус и тело, как это сделал бы Fastify. */
function fakeReply() {
  const sent: Array<{ statusCode: number; body: unknown }> = [];
  const reply = {
    statusCode: 200,
    status(code: number) {
      reply.statusCode = code;
      return reply;
    },
    async send(body: unknown) {
      sent.push({ statusCode: reply.statusCode, body });
      return reply;
    },
  };
  return { reply: reply as unknown as FastifyReply, sent };
}

/** Заглушка запроса: только то, что читает `requireStaff` (сессия сотрудника и id запроса). */
function fakeRequest(authStaff: AuthStaff | null) {
  return { authStaff, id: 'req-1' } as unknown as FastifyRequest;
}

const admin: AuthStaff = {
  id: '55555555-5555-4555-8555-555555555555',
  email: 'admin@example.invalid',
  role: 'admin',
  isActive: true,
};
const manager: AuthStaff = { ...admin, role: 'manager' };

describe('makeRequireStaff', () => {
  it('passes any active employee through when no roles are restricted', async () => {
    const requireStaff = makeRequireStaff();
    const { reply, sent } = fakeReply();

    await requireStaff(fakeRequest(manager), reply);

    expect(sent).toEqual([]);
  });

  it('responds 401 without a staff session', async () => {
    const { reply, sent } = fakeReply();

    await makeRequireStaff()(fakeRequest(null), reply);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.statusCode).toBe(401);
    expect(sent[0]?.body).toMatchObject({ error: { code: 'unauthorized', requestId: 'req-1' } });
  });

  it('responds 401 for a deactivated employee even with a live session', async () => {
    const { reply, sent } = fakeReply();

    await makeRequireStaff(['admin'])(fakeRequest({ ...admin, isActive: false }), reply);

    expect(sent[0]?.statusCode).toBe(401);
    expect(sent[0]?.body).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('responds 403 when the role is not in the allowed list', async () => {
    const { reply, sent } = fakeReply();

    await makeRequireStaff(['admin'])(fakeRequest(manager), reply);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.statusCode).toBe(403);
    expect(sent[0]?.body).toMatchObject({ error: { code: 'forbidden', requestId: 'req-1' } });
  });

  it('passes an employee whose role is allowed', async () => {
    const { reply, sent } = fakeReply();

    await makeRequireStaff(['admin', 'manager'])(fakeRequest(manager), reply);

    expect(sent).toEqual([]);
  });

  it('keeps client and staff cookies apart', async () => {
    // Разные имена cookie — основа изоляции: клиентская сессия не подставляется в staff-роуты
    // (сам резолв сессии проверяется интеграционным тестом).
    expect(STAFF_SESSION_COOKIE_NAME).toBe('hl_staff_session');
    expect(SESSION_COOKIE_NAME).toBe('hl_session');
    expect(STAFF_SESSION_COOKIE_NAME).not.toBe(SESSION_COOKIE_NAME);
  });
});
