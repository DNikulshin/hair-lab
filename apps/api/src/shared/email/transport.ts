/**
 * Транспорт писем: контракт и классификация ошибок.
 *
 * Провайдер подключается адаптером (`EmailTransport`): сейчас SMTP через nodemailer,
 * позже — HTTP API провайдера. Бизнес-логике (диспетчеру) важны не тексты ошибок,
 * а решение: письмо ушло, повторять или адрес получателя отклонён постоянно.
 *
 * Персональные данные: в интерфейсе `SendResult` есть только код SMTP-ответа и этап
 * отказа — именно они попадают в лог и в `outbox_messages.last_error`.
 */

/** Что делать с письмом после попытки отправки. */
export type SendOutcome =
  /** Письмо принято сервером. */
  | 'sent'
  /** Временная ошибка (4xx, таймаут, сеть): повторить позже. */
  | 'retry'
  /** Подтверждённый постоянный отказ получателя (5xx на `RCPT TO`): повторять бессмысленно. */
  | 'suppressed';

/**
 * Этап SMTP-сессии, на котором произошёл отказ (nodemailer `error.command`).
 * Список закрытый: значения используются в `last_error` и логах, поэтому свободный
 * текст команды (в котором теоретически может оказаться данные письма) не сохраняется.
 */
export type SmtpStage =
  'CONNECT' | 'EHLO' | 'AUTH' | 'MAIL FROM' | 'RCPT TO' | 'DATA' | 'QUIT' | 'OTHER';

export interface SendResult {
  outcome: SendOutcome;
  /** Код ответа SMTP (`250`, `421`, `535`, …). Единственное, что можно писать в лог. */
  responseCode?: number;
  /** Этап отказа; у ошибок без `command` (таймаут, сеть) отсутствует. */
  stage?: SmtpStage;
}

/** Письмо, готовое к отправке: рендер шаблона уже произошёл. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
}

/** Адаптер отправки. Реализация не бросает исключений на ошибках SMTP — возвращает `SendResult`. */
export interface EmailTransport {
  send(message: EmailMessage): Promise<SendResult>;
  /** Освобождение ресурсов при остановке приложения. */
  close?(): void;
}

/** Код SMTP-ответа из ошибки: `responseCode` (nodemailer), он же `code` у части ошибок. */
function smtpCodeOf(error: unknown): number | undefined {
  const candidate = (error as { responseCode?: unknown } | null | undefined)?.responseCode;
  return typeof candidate === 'number' && Number.isInteger(candidate) ? candidate : undefined;
}

/** Известные значения `error.command` nodemailer → этап в нормализованном виде. */
const STAGE_BY_COMMAND: Record<string, SmtpStage> = {
  connect: 'CONNECT',
  ehlo: 'EHLO',
  helo: 'EHLO',
  auth: 'AUTH',
  'mail from': 'MAIL FROM',
  'rcpt to': 'RCPT TO',
  data: 'DATA',
  quit: 'QUIT',
};

/**
 * Этап SMTP из `error.command` (`'MAIL FROM'`, `'RCPT TO'`, `'AUTH PLAIN'`, …).
 * `command` может отсутствовать — тогда этап неизвестен (`undefined`).
 */
function smtpStageOf(error: unknown): SmtpStage | undefined {
  const command = (error as { command?: unknown } | null | undefined)?.command;
  if (typeof command !== 'string') return undefined;
  const normalized = command.trim().toLowerCase();
  if (normalized === '') return undefined;
  const exact = STAGE_BY_COMMAND[normalized];
  if (exact !== undefined) return exact;
  // `AUTH PLAIN`, `AUTH LOGIN …` — этап тот же, подробности механизма не сохраняем.
  const firstWord = normalized.split(/\s+/)[0] ?? '';
  return STAGE_BY_COMMAND[firstWord] ?? 'OTHER';
}

const PERMANENT_REJECTION_MIN = 550;
const PERMANENT_REJECTION_MAX = 554;

/**
 * Классификация ошибки отправки по коду SMTP-ответа **и этапу отказа**:
 * - `5xx` на `RCPT TO` — сервер отказал именно получателю (нет ящика, спам-фильтр): suppress;
 * - `5xx` на `MAIL FROM`/`DATA`/`AUTH`/… — отказ отправителю, политика содержимого или
 *   конфигурация: письмо не виновато, после исправления настроек его нужно отправить → retry;
 * - `5xx` без этапа — подтверждения отказа получателю нет → retry;
 * - остальные `4xx`/`5xx` (включая `535` — неверные учётные данные) — retry;
 * - без кода (таймаут, обрыв соединения, DNS, TLS) — retry.
 *
 * Текст ошибки не разбирается: в нём бывают адреса и тела писем, а в лог они не попадают.
 */
export function classifyTransportError(error: unknown): SendResult {
  const responseCode = smtpCodeOf(error);
  const stage = smtpStageOf(error);

  if (responseCode === undefined) {
    return stage === undefined ? { outcome: 'retry' } : { outcome: 'retry', stage };
  }

  // Подавляем только подтверждённый отказ получателю: 5xx именно на `RCPT TO`.
  const recipientRejected =
    stage === 'RCPT TO' &&
    responseCode >= PERMANENT_REJECTION_MIN &&
    responseCode <= PERMANENT_REJECTION_MAX;
  const outcome: SendOutcome = recipientRejected ? 'suppressed' : 'retry';

  return stage === undefined ? { outcome, responseCode } : { outcome, responseCode, stage };
}

/** Код успешного ответа из строки вида `250 2.0.0 Ok: queued as …`. */
export function responseCodeOf(
  info: { response?: unknown } | null | undefined,
): number | undefined {
  const response = info?.response;
  if (typeof response !== 'string') return undefined;
  const match = /^(\d{3})\b/.exec(response);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * Текст для `last_error`: только код ответа и этап отказа или нейтральная метка.
 * Адресов, имён и тел писем здесь быть не может.
 */
export function errorDetailOf(result: SendResult): string {
  if (result.responseCode === undefined) return 'transport_error';
  return result.stage === undefined
    ? `smtp ${result.responseCode}`
    : `smtp ${result.responseCode} ${result.stage}`;
}
