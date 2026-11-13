import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import emailPlugin from './plugin';
import type { ClaimedMessage, OutboxStore } from './outbox-store';
import type { EmailTemplateRegistry } from './templates';
import type { EmailTransport } from './transport';

/**
 * Плагин почты: запуск по таймеру, отсутствие наложения тиков и остановка через `app.close()`.
 * Проверяем на дешёвых фейках — отправки и БД не нужны.
 */
const templates: EmailTemplateRegistry = {
  test: {
    render: () => ({
      to: 'guest@example.invalid',
      subject: 'Тема',
      text: 'Текст',
      html: '<p>Текст</p>',
      startsAt: new Date(Date.now() + 60_000),
    }),
  },
};

interface FakeStore extends OutboxStore {
  claimCalls: number;
}

function createStore(options: { throwOnClaim?: boolean } = {}): FakeStore {
  const store: FakeStore = {
    claimCalls: 0,
    async claim(): Promise<ClaimedMessage[]> {
      store.claimCalls += 1;
      if (options.throwOnClaim === true) throw new Error('нет соединения с БД');
      return [];
    },
    async markSent() {},
    async markAttemptFailed() {},
    async markFailed() {},
    async markSuppressed() {},
    async countSentSince() {
      return 0;
    },
  };
  return store;
}

function createTransport(): EmailTransport & { closed: boolean } {
  return {
    closed: false,
    async send() {
      return { outcome: 'sent', responseCode: 250 };
    },
    close() {
      this.closed = true;
    },
  };
}

/** Ожидание условия: таймер плагина асинхронный, точный момент тика не гарантирован. */
async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate() && Date.now() - startedAt < timeoutMs) {
    await delay(5);
  }
}

describe('плагин почты', () => {
  it('без SMTP не запускает диспетчер и пишет один info-лог', async () => {
    const app = Fastify({ logger: false });
    const store = createStore();

    await app.register(emailPlugin, {
      enabled: false,
      templates,
      intervalMs: 5,
      createStore: () => store,
      createTransport,
    });
    await app.ready();

    await delay(40);
    await app.close();

    expect(store.claimCalls).toBe(0);
  });

  it('запускает тики и останавливает таймер по app.close()', async () => {
    const app = Fastify({ logger: false });
    const store = createStore();
    const transport = createTransport();

    await app.register(emailPlugin, {
      enabled: true,
      templates,
      intervalMs: 5,
      createStore: () => store,
      createTransport: () => transport,
    });
    await app.ready();

    await waitFor(() => store.claimCalls > 0);
    expect(store.claimCalls).toBeGreaterThan(0);

    await app.close();
    const afterClose = store.claimCalls;
    await delay(30);

    expect(store.claimCalls).toBe(afterClose);
    expect(transport.closed).toBe(true);
  });

  it('ошибка тика не роняет приложение', async () => {
    const app = Fastify({ logger: false });
    const store = createStore({ throwOnClaim: true });

    await app.register(emailPlugin, {
      enabled: true,
      templates,
      intervalMs: 5,
      createStore: () => store,
      createTransport,
    });
    await app.ready();

    await waitFor(() => store.claimCalls > 1);
    expect(store.claimCalls).toBeGreaterThan(1);

    // Приложение живо и корректно закрывается.
    await expect(app.close()).resolves.toBeUndefined();
  });
});
