import type { Db } from '../db';

/**
 * Хранилище очереди писем (transactional outbox).
 *
 * Интерфейс отделён от Prisma, чтобы диспетчер проверялся unit-тестами без БД.
 * Все запросы идут по первичному ключу или по индексу `(status, next_attempt_at)`;
 * блокировок строк нет: экземпляр API один (см. AGENTS.md, допущения о развёртывании).
 */
export interface ClaimedMessage {
  id: string;
  type: string;
  /** Снимок данных для шаблона, разбирается Zod-схемой шаблона. */
  payload: unknown;
  /** Число уже сделанных неудачных попыток. */
  attempts: number;
}

export interface OutboxStore {
  /** Следующая пачка писем к отправке: `pending` с наступившим `next_attempt_at`. */
  claim(now: Date, limit: number): Promise<ClaimedMessage[]>;
  /** Письмо принято сервером. */
  markSent(id: string, sentAt: Date): Promise<void>;
  /** Попытка не удалась: `attempts + 1`, новая пауза, текст ошибки (код SMTP). */
  markAttemptFailed(id: string, nextAttemptAt: Date, detail: string): Promise<void>;
  /** Исчерпаны попытки, снимок невалиден или событие прошло — дальше не отправляем. */
  markFailed(id: string, detail: string): Promise<void>;
  /** Постоянный отказ получателя (5xx по адресу). */
  markSuppressed(id: string, detail: string): Promise<void>;
  /** Сколько писем отправлено начиная с момента: лимиты 30/мин и 200/сутки. */
  countSentSince(since: Date): Promise<number>;
}

/** Реализация на Prisma: единственная точка записи в `outbox_messages` из API. */
export function createPrismaOutboxStore(db: Db): OutboxStore {
  return {
    async claim(now, limit) {
      return db.outboxMessage.findMany({
        where: { status: 'pending', nextAttemptAt: { lte: now } },
        orderBy: { nextAttemptAt: 'asc' },
        take: limit,
        select: { id: true, type: true, payload: true, attempts: true },
      });
    },

    async markSent(id, sentAt) {
      await db.outboxMessage.update({ where: { id }, data: { status: 'sent', sentAt } });
    },

    async markAttemptFailed(id, nextAttemptAt, detail) {
      await db.outboxMessage.update({
        where: { id },
        data: {
          status: 'pending',
          attempts: { increment: 1 },
          nextAttemptAt,
          lastError: detail,
        },
      });
    },

    async markFailed(id, detail) {
      await db.outboxMessage.update({
        where: { id },
        data: { status: 'failed', lastError: detail },
      });
    },

    async markSuppressed(id, detail) {
      await db.outboxMessage.update({
        where: { id },
        data: { status: 'suppressed', lastError: detail },
      });
    },

    async countSentSince(since) {
      return db.outboxMessage.count({ where: { sentAt: { gte: since } } });
    },
  };
}
