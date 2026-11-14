import type { FastifyPluginAsync } from 'fastify';
import { createHoldsSweeper } from './holds-sweeper';
import type { PaymentGateway } from './payment-gateway';
import { paymentsRoutes } from './payments.routes';

/**
 * Плагин оплаты записи: маршруты фичи и фоновый свипер истёкших холдов.
 *
 * Аналогично плагину почты: включается только при `PAYMENTS_MODE != 'off'` (решение принимает
 * `app/build-server.ts`), работает в процессе API — отдельный worker для одного таймера не нужен
 * (один инстанс API, ADR 0005). Остановка по `onClose`: таймер очищается, текущий тик
 * дожидается, чтобы `app.close()` не оставлял висящих запросов к БД.
 *
 * Тики не накладываются друг на друга (`inFlight`): медленный тик не запускает второй.
 * Ошибки внутри тика гасит сам свипер, процесс они не роняют.
 */

export interface PaymentsPluginOptions {
  gateway: PaymentGateway;
  /** Период тика свипера (`PAYMENT_SWEEP_INTERVAL_MS`). */
  sweepIntervalMs: number;
}

export const paymentsPlugin: FastifyPluginAsync<PaymentsPluginOptions> = async (app, options) => {
  await app.register(paymentsRoutes, { gateway: options.gateway });

  const sweeper = createHoldsSweeper({
    db: app.db,
    // Шлюз тот же, что у маршрутов: свипер повторяет обязательные возвраты, когда вызов
    // в обработчике уведомления не удался.
    gateway: options.gateway,
    intervalMs: options.sweepIntervalMs,
    logger: app.log,
  });

  let inFlight: Promise<void> | null = null;
  const runTick = (): void => {
    if (inFlight !== null) return;
    inFlight = sweeper
      .tick()
      .then(() => undefined)
      .finally(() => {
        inFlight = null;
      });
  };

  const timer = setInterval(runTick, options.sweepIntervalMs);
  // Таймер не держит процесс: иначе сервер не остановить по SIGTERM и не закрыть в тестах.
  timer.unref();

  app.log.info({ intervalMs: options.sweepIntervalMs }, 'свипер истёкших холдов оплаты запущен');

  app.addHook('onClose', async () => {
    clearInterval(timer);
    await inFlight;
  });
};
