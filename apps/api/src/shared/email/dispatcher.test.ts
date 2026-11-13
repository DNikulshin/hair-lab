import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MINUTES,
  BATCH_SIZE,
  createDispatcher,
  MAX_ATTEMPTS,
  PER_DAY_LIMIT,
  PER_MINUTE_LIMIT,
  type DispatcherLogger,
} from './dispatcher';
import type { ClaimedMessage, OutboxStore } from './outbox-store';
import type { EmailTemplateRegistry, RenderedEmail } from './templates';
import type { EmailTransport, SendResult } from './transport';

/**
 * Диспетчер outbox на фейковых хранилище, транспорте и логгере: проверяем решения
 * (sent/retry/suppressed/failed), паузы, лимиты и отсутствие ПДн в логах.
 * Персональные данные в тестах вымышленные.
 */
const NOW = new Date('2026-11-20T09:00:00.000Z');
const MINUTE_MS = 60_000;
const FUTURE = new Date('2026-11-25T07:00:00.000Z');
const CLIENT_EMAIL = 'guest@example.invalid';
const CLIENT_NAME = 'Тестовая Клиентка';

const fixedNow = () => NOW;

interface LogEntry {
  level: 'info' | 'warn' | 'error';
  obj: Record<string, unknown>;
  msg: string;
}

function createLogger(): { logger: DispatcherLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger: DispatcherLogger = {
    info: (obj, msg) => entries.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => entries.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => entries.push({ level: 'error', obj, msg }),
  };
  return { logger, entries };
}

interface StoreCalls {
  claim: Array<{ now: Date; limit: number }>;
  markSent: Array<{ id: string; sentAt: Date }>;
  markAttemptFailed: Array<{ id: string; nextAttemptAt: Date; detail: string }>;
  markFailed: Array<{ id: string; detail: string }>;
  markSuppressed: Array<{ id: string; detail: string }>;
}

interface FakeStoreOptions {
  messages?: ClaimedMessage[];
  sentLastMinute?: number;
  sentLastDay?: number;
  /** Заставить `claim` бросить исключение: проверка «тик не роняет процесс». */
  claimError?: Error;
}

function createStore(options: FakeStoreOptions = {}): {
  store: OutboxStore;
  calls: StoreCalls;
} {
  const calls: StoreCalls = {
    claim: [],
    markSent: [],
    markAttemptFailed: [],
    markFailed: [],
    markSuppressed: [],
  };

  const store: OutboxStore = {
    async claim(now, limit) {
      calls.claim.push({ now, limit });
      if (options.claimError !== undefined) throw options.claimError;
      return (options.messages ?? []).slice(0, limit);
    },
    async markSent(id, sentAt) {
      calls.markSent.push({ id, sentAt });
    },
    async markAttemptFailed(id, nextAttemptAt, detail) {
      calls.markAttemptFailed.push({ id, nextAttemptAt, detail });
    },
    async markFailed(id, detail) {
      calls.markFailed.push({ id, detail });
    },
    async markSuppressed(id, detail) {
      calls.markSuppressed.push({ id, detail });
    },
    async countSentSince(since) {
      // Диспетчер спрашивает сначала окно минуты, затем суток.
      return since.getTime() > NOW.getTime() - 60 * MINUTE_MS
        ? (options.sentLastMinute ?? 0)
        : (options.sentLastDay ?? 0);
    },
  };

  return { store, calls };
}

function createTransport(...results: SendResult[]): {
  transport: EmailTransport;
  sent: RenderedEmail[];
} {
  const sent: RenderedEmail[] = [];
  let index = 0;
  return {
    sent,
    transport: {
      async send(message) {
        sent.push({ ...message, startsAt: FUTURE });
        const result = results[Math.min(index, results.length - 1)] ?? { outcome: 'sent' };
        index += 1;
        return result;
      },
    },
  };
}

const templates: EmailTemplateRegistry = {
  booking_confirmation: {
    render: (payload) => {
      const data = payload as { clientEmail?: unknown; startsAt?: unknown };
      if (typeof data.clientEmail !== 'string' || typeof data.startsAt !== 'string') {
        throw new Error('invalid payload');
      }
      return {
        to: data.clientEmail,
        subject: 'Запись создана',
        text: `Здравствуйте, ${CLIENT_NAME}!`,
        html: `<p>Здравствуйте, ${CLIENT_NAME}!</p>`,
        replyTo: 'hello@example.invalid',
        startsAt: new Date(data.startsAt),
      };
    },
  },
};

function message(overrides: Partial<ClaimedMessage> = {}): ClaimedMessage {
  return {
    id: 'outbox-1',
    type: 'booking_confirmation',
    payload: { clientEmail: CLIENT_EMAIL, startsAt: FUTURE.toISOString() },
    attempts: 0,
    ...overrides,
  };
}

function runTick(
  storeOptions: FakeStoreOptions,
  transportResults: SendResult[] = [{ outcome: 'sent', responseCode: 250 }],
) {
  const { store, calls } = createStore(storeOptions);
  const { transport, sent } = createTransport(...transportResults);
  const { logger, entries } = createLogger();
  const dispatcher = createDispatcher({
    store,
    transport,
    templates,
    logger,
    now: fixedNow,
  });
  return { dispatcher, calls, sent, entries };
}

describe('диспетчер: результат отправки', () => {
  it('вызывает afterSent только после успешной доставки', async () => {
    let afterSentCalls = 0;
    const callbackTemplates: EmailTemplateRegistry = {
      booking_confirmation: {
        render: () => ({
          to: CLIENT_EMAIL,
          subject: 'Тест',
          text: 'Тест',
          html: '<p>Тест</p>',
          startsAt: FUTURE,
          afterSent: () => {
            afterSentCalls += 1;
          },
        }),
      },
    };
    const { store } = createStore({ messages: [message()] });
    const { transport } = createTransport({ outcome: 'retry', responseCode: 421 });
    const { logger } = createLogger();
    const dispatcher = createDispatcher({
      store,
      transport,
      templates: callbackTemplates,
      logger,
      now: fixedNow,
    });

    await dispatcher.tick();
    expect(afterSentCalls).toBe(0);

    const successStore = createStore({ messages: [message()] }).store;
    const { transport: successTransport } = createTransport({ outcome: 'sent', responseCode: 250 });
    const successDispatcher = createDispatcher({
      store: successStore,
      transport: successTransport,
      templates: callbackTemplates,
      logger,
      now: fixedNow,
    });
    await successDispatcher.tick();
    expect(afterSentCalls).toBe(1);
  });

  it('успех — статус sent и время отправки', async () => {
    const { dispatcher, calls, sent } = runTick({ messages: [message()] });

    const result = await dispatcher.tick();

    expect(result).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    expect(calls.markSent).toEqual([{ id: 'outbox-1', sentAt: NOW }]);
    expect(calls.markAttemptFailed).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(CLIENT_EMAIL);
  });

  it('временная ошибка — attempts + 1 и пауза 1 минута', async () => {
    const { dispatcher, calls } = runTick({ messages: [message()] }, [
      { outcome: 'retry', responseCode: 421 },
    ]);

    const result = await dispatcher.tick();

    expect(result.retried).toBe(1);
    expect(calls.markAttemptFailed).toEqual([
      {
        id: 'outbox-1',
        nextAttemptAt: new Date(NOW.getTime() + 1 * MINUTE_MS),
        detail: 'smtp 421',
      },
    ]);
    expect(calls.markFailed).toEqual([]);
  });

  it('паузы растут: 1, 5, 15, 60 и 240 минут', async () => {
    const expected = [1, 5, 15, 60, 240];
    expect([...BACKOFF_MINUTES]).toEqual(expected);

    for (const [index, pauseMin] of expected.entries()) {
      const { dispatcher, calls } = runTick({ messages: [message({ attempts: index })] }, [
        { outcome: 'retry', responseCode: 451 },
      ]);

      await dispatcher.tick();

      expect(calls.markAttemptFailed[0]?.nextAttemptAt).toEqual(
        new Date(NOW.getTime() + pauseMin * MINUTE_MS),
      );
    }
  });

  it('после исчерпания повторов — failed, без новой паузы', async () => {
    const { dispatcher, calls } = runTick({ messages: [message({ attempts: MAX_ATTEMPTS })] }, [
      { outcome: 'retry', responseCode: 451 },
    ]);

    const result = await dispatcher.tick();

    expect(result.failed).toBe(1);
    expect(calls.markAttemptFailed).toEqual([]);
    expect(calls.markFailed).toEqual([{ id: 'outbox-1', detail: 'smtp 451' }]);
  });

  it('постоянный отказ получателя — suppressed', async () => {
    const { dispatcher, calls } = runTick({ messages: [message()] }, [
      { outcome: 'suppressed', responseCode: 550 },
    ]);

    const result = await dispatcher.tick();

    expect(result.suppressed).toBe(1);
    expect(calls.markSuppressed).toEqual([{ id: 'outbox-1', detail: 'smtp 550' }]);
    expect(calls.markAttemptFailed).toEqual([]);
  });

  it('неизвестный тип письма — failed без отправки', async () => {
    const { dispatcher, calls, sent } = runTick({ messages: [message({ type: 'unknown' })] });

    const result = await dispatcher.tick();

    expect(result.failed).toBe(1);
    expect(calls.markFailed).toEqual([{ id: 'outbox-1', detail: 'unknown_type' }]);
    expect(sent).toHaveLength(0);
  });

  it('невалидный снимок payload — failed без отправки', async () => {
    const { dispatcher, calls, sent } = runTick({
      messages: [message({ payload: { clientEmail: CLIENT_EMAIL } })],
    });

    const result = await dispatcher.tick();

    expect(result.failed).toBe(1);
    expect(calls.markFailed).toEqual([{ id: 'outbox-1', detail: 'invalid_payload' }]);
    expect(sent).toHaveLength(0);
  });

  it('просроченное событие — failed(expired), транспорт не вызывается', async () => {
    const past = new Date(NOW.getTime() - MINUTE_MS).toISOString();
    const { dispatcher, calls, sent } = runTick({
      messages: [message({ payload: { clientEmail: CLIENT_EMAIL, startsAt: past } })],
    });

    const result = await dispatcher.tick();

    expect(result.failed).toBe(1);
    expect(calls.markFailed).toEqual([{ id: 'outbox-1', detail: 'expired' }]);
    expect(sent).toHaveLength(0);
  });
});

describe('диспетчер: лимиты отправки', () => {
  it('пачка не больше BATCH_SIZE', async () => {
    const messages = Array.from({ length: BATCH_SIZE + 5 }, (_, index) =>
      message({ id: `outbox-${index}` }),
    );
    const { dispatcher, calls } = runTick({ messages });

    const result = await dispatcher.tick();

    expect(calls.claim[0]?.limit).toBe(BATCH_SIZE);
    expect(result.claimed).toBe(BATCH_SIZE);
  });

  it('учитывает лимит 30 писем в минуту', async () => {
    const { dispatcher, calls } = runTick({
      messages: [message()],
      sentLastMinute: PER_MINUTE_LIMIT - 2,
    });

    await dispatcher.tick();

    expect(calls.claim[0]?.limit).toBe(2);
  });

  it('учитывает лимит 200 писем в сутки', async () => {
    const { dispatcher, calls } = runTick({
      messages: [message()],
      sentLastDay: PER_DAY_LIMIT - 1,
    });

    await dispatcher.tick();

    expect(calls.claim[0]?.limit).toBe(1);
  });

  it('при исчерпанном лимите тик ничего не забирает', async () => {
    const { dispatcher, calls, entries } = runTick({
      messages: [message()],
      sentLastMinute: PER_MINUTE_LIMIT,
    });

    const result = await dispatcher.tick();

    expect(result.rateLimited).toBe(true);
    expect(result.claimed).toBe(0);
    expect(calls.claim).toEqual([]);
    expect(entries.some((entry) => entry.msg.includes('лимит'))).toBe(true);
  });
});

describe('диспетчер: фактическое время отправки', () => {
  interface Clock {
    now: () => Date;
    advance: (ms: number) => void;
  }

  function createClock(start: Date): Clock {
    let current = start.getTime();
    return {
      now: () => new Date(current),
      advance: (ms) => {
        current += ms;
      },
    };
  }

  /**
   * Хранилище, которое считает `sent_at` по настоящим временам отправки:
   * так проверяется, что лимиты ведутся по фактическому времени, а не по началу тика.
   */
  function createTimeAwareStore(
    messages: ClaimedMessage[],
    options: { ignoreLimit?: boolean } = {},
  ) {
    const sentAt: Date[] = [];
    const pending = [...messages];
    const calls = {
      claim: [] as Array<{ now: Date; limit: number }>,
      markSent: [] as Array<{ id: string; sentAt: Date }>,
    };

    const store: OutboxStore = {
      async claim(now, limit) {
        calls.claim.push({ now, limit });
        return options.ignoreLimit === true ? [...pending] : pending.slice(0, limit);
      },
      async markSent(id, at) {
        calls.markSent.push({ id, sentAt: at });
        sentAt.push(at);
        const index = pending.findIndex((item) => item.id === id);
        if (index >= 0) pending.splice(index, 1);
      },
      async markAttemptFailed() {
        // В этих тестах не используется.
      },
      async markFailed() {
        // В этих тестах не используется.
      },
      async markSuppressed() {
        // В этих тестах не используется.
      },
      async countSentSince(since) {
        return sentAt.filter((sent) => sent.getTime() >= since.getTime()).length;
      },
    };

    /** Письма, отправленные не этим тиком (другой тик/другой инстанс) — только для счётчика. */
    const addSent = (...times: Date[]): void => {
      sentAt.push(...times);
    };

    return { store, calls, addSent };
  }

  /** Транспорт, который «тратит время»: часы двигаются на каждой отправке. */
  function createSlowTransport(
    clock: Clock,
    options: { advanceMs?: number; result?: SendResult } = {},
  ): EmailTransport {
    const advanceMs = options.advanceMs ?? 7_000;
    const result = options.result ?? { outcome: 'sent', responseCode: 250 };
    return {
      async send() {
        clock.advance(advanceMs);
        return result;
      },
    };
  }

  const batch = (count: number): ClaimedMessage[] =>
    Array.from({ length: count }, (_, index) => message({ id: `outbox-${index}` }));

  it('sent_at — время после send, а не начало тика', async () => {
    const clock = createClock(NOW);
    const { store, calls } = createTimeAwareStore(batch(3));
    const { logger } = createLogger();
    const dispatcher = createDispatcher({
      store,
      transport: createSlowTransport(clock, { advanceMs: 20_000 }),
      templates,
      logger,
      now: clock.now,
    });

    const result = await dispatcher.tick();

    expect(result.sent).toBe(3);
    expect(calls.markSent).toEqual([
      { id: 'outbox-0', sentAt: new Date(NOW.getTime() + 20_000) },
      { id: 'outbox-1', sentAt: new Date(NOW.getTime() + 40_000) },
      { id: 'outbox-2', sentAt: new Date(NOW.getTime() + 60_000) },
    ]);
    // Начало тика осталось моментом выборки из очереди.
    expect(calls.claim[0]?.now).toEqual(NOW);
  });

  it('следующий тик видит в окне последней минуты письма медленной пачки', async () => {
    const clock = createClock(NOW);
    const { store, calls, addSent } = createTimeAwareStore(batch(BATCH_SIZE));
    const { logger } = createLogger();
    const dispatcher = createDispatcher({
      store,
      transport: createSlowTransport(clock, { advanceMs: 7_000 }),
      templates,
      logger,
      now: clock.now,
    });

    const first = await dispatcher.tick();
    expect(first.sent).toBe(BATCH_SIZE);
    expect(clock.now()).toEqual(new Date(NOW.getTime() + BATCH_SIZE * 7_000));

    // 9 из 10 писем попали в последнюю минуту (первое — уже раньше минуты назад).
    const inLastMinute = calls.markSent.filter(
      (call) => call.sentAt.getTime() >= clock.now().getTime() - MINUTE_MS,
    ).length;
    expect(inLastMinute).toBe(9);

    // Плюс 22 письма, отправленные извне: 31 за минуту → тик обязан подождать.
    addSent(
      ...Array.from(
        { length: 22 },
        (_, index) => new Date(clock.now().getTime() - (index + 1) * 1_000),
      ),
    );

    const second = await dispatcher.tick();

    expect(second.rateLimited).toBe(true);
    expect(second.claimed).toBe(0);
    // Пачка даже не выбирается: бюджет посчитан по фактическим sent_at.
    expect(calls.claim).toHaveLength(1);
  });

  it('бюджет пересчитывается в середине тика: лимит не превышается', async () => {
    const { store, calls } = createTimeAwareStore(batch(5), { ignoreLimit: true });
    const { logger, entries } = createLogger();
    // 28 писем уже ушло за последнюю минуту: в тике можно отправить только 2.
    const atLimitStore: OutboxStore = {
      ...store,
      async countSentSince(since) {
        const isMinuteWindow = since.getTime() > NOW.getTime() - 60 * MINUTE_MS;
        return isMinuteWindow ? PER_MINUTE_LIMIT - 2 : 0;
      },
    };
    const dispatcher = createDispatcher({
      store: atLimitStore,
      transport: createTransport().transport,
      templates,
      logger,
      now: fixedNow,
    });

    const result = await dispatcher.tick();

    expect(result.sent).toBe(2);
    expect(calls.markSent.map((call) => call.id)).toEqual(['outbox-0', 'outbox-1']);
    expect(result.rateLimited).toBe(true);
    expect(entries.some((entry) => entry.msg.includes('в середине тика'))).toBe(true);
  });

  it('пауза перед повтором считается от момента отказа, а не от начала тика', async () => {
    const clock = createClock(NOW);
    const { store } = createTimeAwareStore(batch(1));
    const { logger } = createLogger();
    const failedAt: Date[] = [];
    const instrumented: OutboxStore = {
      ...store,
      async markAttemptFailed(_id, nextAttemptAt, detail) {
        failedAt.push(nextAttemptAt);
        expect(detail).toBe('smtp 421');
      },
    };
    const dispatcher = createDispatcher({
      store: instrumented,
      transport: createSlowTransport(clock, {
        advanceMs: 30_000,
        result: { outcome: 'retry', responseCode: 421 },
      }),
      templates,
      logger,
      now: clock.now,
    });

    await dispatcher.tick();

    expect(failedAt).toEqual([new Date(NOW.getTime() + 30_000 + 1 * MINUTE_MS)]);
  });
});

describe('диспетчер: устойчивость и персональные данные', () => {
  it('ошибка хранилища не роняет тик и логируется без текста исключения', async () => {
    const { dispatcher, entries } = runTick({
      claimError: new Error(`нет соединения с БД для ${CLIENT_EMAIL}`),
    });

    const result = await dispatcher.tick();

    expect(result.claimed).toBe(0);
    const errorEntry = entries.find((entry) => entry.level === 'error');
    expect(errorEntry?.obj).toEqual({ errorName: 'Error' });
    expect(JSON.stringify(entries)).not.toContain(CLIENT_EMAIL);
  });

  it('в логи не попадают email, имя клиента и тела писем', async () => {
    const { dispatcher, entries } = runTick({ messages: [message()] });

    await dispatcher.tick();

    const dump = JSON.stringify(entries);
    expect(dump).not.toContain(CLIENT_EMAIL);
    expect(dump).not.toContain(CLIENT_NAME);
    expect(dump).not.toContain('Запись создана');
    // Идентификатор и тип сообщения — можно.
    expect(dump).toContain('outbox-1');
    expect(dump).toContain('booking_confirmation');
  });

  it('в логи попадает только id, type и код SMTP-ответа', async () => {
    const { dispatcher, entries } = runTick({ messages: [message()] }, [
      { outcome: 'retry', responseCode: 451 },
    ]);

    await dispatcher.tick();

    const warnEntry = entries.find((entry) => entry.level === 'warn');
    expect(warnEntry?.obj).toMatchObject({ outboxId: 'outbox-1', responseCode: 451 });
  });

  it('недоступный транспорт (исключение) трактуется как повтор', async () => {
    const { store, calls } = createStore({ messages: [message()] });
    const { logger } = createLogger();
    const dispatcher = createDispatcher({
      store,
      transport: {
        async send() {
          throw new Error('boom');
        },
      },
      templates,
      logger,
      now: fixedNow,
    });

    const result = await dispatcher.tick();

    expect(result.retried).toBe(1);
    expect(calls.markAttemptFailed).toHaveLength(1);
  });
});
