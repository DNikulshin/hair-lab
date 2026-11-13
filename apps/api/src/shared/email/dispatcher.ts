import type { OutboxStore } from './outbox-store';
import type { EmailTemplateRegistry, RenderedEmail } from './templates';
import { errorDetailOf, type EmailTransport, type SendResult } from './transport';

/**
 * Диспетчер очереди писем: один тик — одна пачка `pending`-сообщений.
 *
 * Правила (issue #9):
 * - паузы перед повтором 1, 5, 15, 60 и 240 минут; после пяти повторов — `failed`;
 * - постоянный отказ получателя (5xx на `RCPT TO`) — `suppressed`, повторов нет;
 * - письмо о событии, которое уже началось, не отправляется — `failed('expired')`;
 * - неизвестный `type` и невалидный снимок `payload` — `failed`, без ретраев;
 * - лимиты отправки: 30 писем в минуту и 200 в сутки (по фактическому `sent_at`).
 *
 * Время отправки — не начало тика, а момент, когда `send` действительно завершился:
 * пачка может рассылаться дольше минуты, и запись времени начала тика завышала бы
 * остаток лимита в следующем тике. Бюджет пересчитывается перед каждым письмом
 * с учётом уже отправленных в этом же тике.
 *
 * Тик не бросает исключений: недоступный SMTP или БД не должны ронять процесс.
 * В лог попадают только id сообщения, `type`, код SMTP-ответа и этап отказа (`MAIL FROM`,
 * `RCPT TO`, `DATA`) — без адресов, имён и тел писем; `last_error` в лог не выводится.
 */

export const TICK_INTERVAL_MS = 10_000;
export const BATCH_SIZE = 10;
export const PER_MINUTE_LIMIT = 30;
export const PER_DAY_LIMIT = 200;
/** Паузы перед повтором, минуты: 1, 5, 15, 60, 240. */
export const BACKOFF_MINUTES = [1, 5, 15, 60, 240] as const;
/**
 * Сколько раз отправку можно повторить (не считая первой попытки): после пятого
 * неудачного повтора письмо становится `failed`. Всего попыток — до 6.
 */
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Минимальный интерфейс логгера: pino из Fastify подходит без адаптера. */
export interface DispatcherLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface DispatcherDeps {
  store: OutboxStore;
  transport: EmailTransport;
  templates: EmailTemplateRegistry;
  logger: DispatcherLogger;
  /** Источник времени: в тестах подменяется. */
  now?: () => Date;
}

export interface TickResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  suppressed: number;
  /** Тик ничего не отправлял из-за лимита (письма остаются в очереди). */
  rateLimited: boolean;
}

export interface Dispatcher {
  tick(): Promise<TickResult>;
}

type MessageOutcome = 'sent' | 'retried' | 'failed' | 'suppressed';

interface HandledMessage {
  outcome: MessageOutcome;
  /** Фактическое время успешной отправки: идёт в `sent_at` и в учёт лимитов. */
  sentAt?: Date;
}

const emptyResult = (): TickResult => ({
  claimed: 0,
  sent: 0,
  retried: 0,
  failed: 0,
  suppressed: 0,
  rateLimited: false,
});

/** Имя ошибки без сообщения: текст исключения может содержать адрес или тело письма. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { store, transport, templates, logger } = deps;
  const now = deps.now ?? (() => new Date());

  /** Обработка одного сообщения. Ошибки БД/транспорта ловит `tick`, письмо остаётся `pending`. */
  async function handle(
    message: {
      id: string;
      type: string;
      payload: unknown;
      attempts: number;
    },
    at: Date,
  ): Promise<HandledMessage> {
    const template = templates[message.type];
    if (template === undefined) {
      await store.markFailed(message.id, 'unknown_type');
      logger.warn({ outboxId: message.id, type: message.type }, 'неизвестный тип письма');
      return { outcome: 'failed' };
    }

    let email: RenderedEmail;
    try {
      email = template.render(message.payload);
    } catch {
      await store.markFailed(message.id, 'invalid_payload');
      logger.warn({ outboxId: message.id, type: message.type }, 'невалидный снимок письма');
      return { outcome: 'failed' };
    }

    if (email.startsAt.getTime() <= at.getTime()) {
      await store.markFailed(message.id, 'expired');
      logger.info(
        { outboxId: message.id, type: message.type },
        'событие прошло, письмо не отправлено',
      );
      return { outcome: 'failed' };
    }

    let result: SendResult;
    try {
      result = await transport.send({
        to: email.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
        ...(email.replyTo === undefined ? {} : { replyTo: email.replyTo }),
      });
    } catch {
      // Транспорт обязан возвращать `SendResult`; исключение — дефект адаптера.
      // Трактуем как временную ошибку, чтобы письмо не потерялось.
      result = { outcome: 'retry' };
    }

    if (result.outcome === 'sent') {
      // Фактическое время после `send`, а не начало тика: по нему считаются лимиты.
      const sentAt = now();
      await store.markSent(message.id, sentAt);
      logger.info(
        {
          outboxId: message.id,
          type: message.type,
          ...(result.responseCode === undefined ? {} : { responseCode: result.responseCode }),
        },
        'письмо отправлено',
      );
      return { outcome: 'sent', sentAt };
    }

    if (result.outcome === 'suppressed') {
      await store.markSuppressed(message.id, errorDetailOf(result));
      logger.warn(
        {
          outboxId: message.id,
          type: message.type,
          ...(result.responseCode === undefined ? {} : { responseCode: result.responseCode }),
          ...(result.stage === undefined ? {} : { stage: result.stage }),
        },
        'получатель отклонён постоянно, повторов не будет',
      );
      return { outcome: 'suppressed' };
    }

    const attempts = message.attempts + 1;
    if (attempts > MAX_ATTEMPTS) {
      await store.markFailed(message.id, errorDetailOf(result));
      logger.error(
        {
          outboxId: message.id,
          type: message.type,
          attempts,
          ...(result.responseCode === undefined ? {} : { responseCode: result.responseCode }),
          ...(result.stage === undefined ? {} : { stage: result.stage }),
        },
        'попытки отправки исчерпаны',
      );
      return { outcome: 'failed' };
    }

    // attempts — номер неудачной попытки (1…MAX_ATTEMPTS), индекс паузы — attempts - 1.
    const pauseMin = BACKOFF_MINUTES[attempts - 1] ?? BACKOFF_MINUTES[0];
    await store.markAttemptFailed(
      message.id,
      // Пауза считается от момента отказа, а не от начала тика.
      new Date(now().getTime() + pauseMin * MINUTE_MS),
      errorDetailOf(result),
    );
    logger.warn(
      {
        outboxId: message.id,
        type: message.type,
        attempts,
        retryInMinutes: pauseMin,
        ...(result.responseCode === undefined ? {} : { responseCode: result.responseCode }),
        ...(result.stage === undefined ? {} : { stage: result.stage }),
      },
      'отправка не удалась, письмо повторят',
    );
    return { outcome: 'retried' };
  }

  return {
    async tick(): Promise<TickResult> {
      const result = emptyResult();
      try {
        const startedAt = now();
        const sentLastMinute = await store.countSentSince(
          new Date(startedAt.getTime() - MINUTE_MS),
        );
        const sentLastDay = await store.countSentSince(new Date(startedAt.getTime() - DAY_MS));

        const budget = Math.min(
          BATCH_SIZE,
          PER_MINUTE_LIMIT - sentLastMinute,
          PER_DAY_LIMIT - sentLastDay,
        );
        if (budget <= 0) {
          result.rateLimited = true;
          logger.warn({ sentLastMinute, sentLastDay }, 'лимит отправки исчерпан, очередь подождёт');
          return result;
        }

        const messages = await store.claim(startedAt, budget);
        result.claimed = messages.length;

        /**
         * Письма, отправленные в этом же тике: в счётчиках store их ещё нет, поэтому
         * учитываем их сами по фактическому времени отправки.
         */
        const sentInTick: Date[] = [];
        const budgetLeft = (current: Date): number => {
          const sentThisMinute = sentInTick.filter(
            (sentAt) => sentAt.getTime() >= current.getTime() - MINUTE_MS,
          ).length;
          const sentThisDay = sentInTick.filter(
            (sentAt) => sentAt.getTime() >= current.getTime() - DAY_MS,
          ).length;
          return Math.min(
            PER_MINUTE_LIMIT - sentLastMinute - sentThisMinute,
            PER_DAY_LIMIT - sentLastDay - sentThisDay,
          );
        };

        // Последовательно: SMTP-сервер и лимиты рассчитаны на один поток отправки.
        for (const message of messages) {
          // Время пересчитывается перед каждым письмом: рассылка пачки может занять минуты.
          const at = now();
          if (budgetLeft(at) <= 0) {
            result.rateLimited = true;
            logger.warn(
              { sentInTick: sentInTick.length, sentLastMinute, sentLastDay },
              'лимит отправки исчерпан в середине тика, остаток пачки подождёт',
            );
            break;
          }

          const handled = await handle(message, at);
          if (handled.outcome === 'sent') {
            result.sent += 1;
            if (handled.sentAt !== undefined) sentInTick.push(handled.sentAt);
          } else if (handled.outcome === 'retried') result.retried += 1;
          else if (handled.outcome === 'suppressed') result.suppressed += 1;
          else result.failed += 1;
        }

        if (messages.length > 0) logger.info({ ...result }, 'тик диспетчера почты завершён');
        return result;
      } catch (error) {
        // Тик не должен ронять процесс: ошибка БД лечится следующим тиком.
        logger.error({ errorName: errorName(error) }, 'тик диспетчера почты прерван ошибкой');
        return result;
      }
    },
  };
}
