/**
 * Публичный API модуля почты: транспорт, хранилище outbox, диспетчер и плагин.
 * Импортировать только из серверного кода `apps/api`; реестр шаблонов внедряет `app`.
 */
export {
  BACKOFF_MINUTES,
  BATCH_SIZE,
  createDispatcher,
  MAX_ATTEMPTS,
  PER_DAY_LIMIT,
  PER_MINUTE_LIMIT,
  TICK_INTERVAL_MS,
  type Dispatcher,
  type DispatcherDeps,
  type DispatcherLogger,
  type TickResult,
} from './dispatcher';
export { createPrismaOutboxStore, type ClaimedMessage, type OutboxStore } from './outbox-store';
export { default as emailPlugin, type EmailPluginOptions } from './plugin';
export { createSmtpTransport, type SmtpTransportOptions } from './smtp-transport';
export type { EmailTemplate, EmailTemplateRegistry, RenderedEmail } from './templates';
export {
  classifyTransportError,
  errorDetailOf,
  responseCodeOf,
  type EmailMessage,
  type EmailTransport,
  type SendOutcome,
  type SendResult,
  type SmtpStage,
} from './transport';
