import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { createDispatcher, TICK_INTERVAL_MS } from './dispatcher';
import type { OutboxStore } from './outbox-store';
import type { EmailTemplateRegistry } from './templates';
import type { EmailTransport } from './transport';

/**
 * Плагин почты: запускает фоновый диспетчер outbox и останавливает его при `app.close()`.
 *
 * - Хранилище и транспорт создаются фабриками и только когда интеграция включена:
 *   без `SMTP_HOST` модуль не стартует (один info-лог), API работает как обычно.
 * - Тики не накладываются друг на друга (`inFlight`), `onClose` ждёт текущий тик.
 * - Ошибка тика логируется внутри диспетчера и процесс не роняет.
 */
export interface EmailPluginOptions {
  enabled: boolean;
  createStore: () => OutboxStore;
  createTransport: () => EmailTransport;
  templates: EmailTemplateRegistry;
  intervalMs?: number;
}

const emailPlugin: FastifyPluginAsync<EmailPluginOptions> = async (app, options) => {
  if (!options.enabled) {
    app.log.info('SMTP не настроен: письма не отправляются, outbox остаётся в БД');
    return;
  }

  const intervalMs = options.intervalMs ?? TICK_INTERVAL_MS;
  const transport = options.createTransport();
  const dispatcher = createDispatcher({
    store: options.createStore(),
    transport,
    templates: options.templates,
    logger: app.log,
  });

  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const runTick = (): void => {
    if (inFlight !== null) return;
    inFlight = dispatcher
      .tick()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        inFlight = null;
      });
  };

  timer = setInterval(runTick, intervalMs);
  // Таймер не держит процесс: без этого нельзя ни остановиться, ни прогнать тесты.
  timer.unref();

  app.log.info({ intervalMs }, 'диспетчер почты запущен');

  app.addHook('onClose', async () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    await inFlight;
    transport.close?.();
  });
};

export default fp(emailPlugin, { name: 'email' });
