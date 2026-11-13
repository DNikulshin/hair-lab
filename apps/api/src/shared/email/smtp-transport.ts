import nodemailer from 'nodemailer';
import {
  classifyTransportError,
  responseCodeOf,
  type EmailMessage,
  type EmailTransport,
  type SendResult,
} from './transport';

/**
 * SMTP-транспорт на nodemailer (ADR 0004: свой ящик на домене салона, без трансграничной
 * передачи ПДн). Таймауты заданы явно: иначе зависшее соединение держит тик диспетчера.
 *
 * Ошибки SMTP классифицируются в `SendResult` и наружу не пробрасываются — диспетчер
 * не должен падать из-за недоступного провайдера.
 */
export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  /** Адрес в поле `From` (домен должен совпадать с доменом салона). */
  fromEmail: string;
  fromName: string;
  connectionTimeoutMs?: number;
  socketTimeoutMs?: number;
}

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 20_000;

export function createSmtpTransport(options: SmtpTransportOptions): EmailTransport {
  const transporter = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    auth: { user: options.user, pass: options.password },
    connectionTimeout: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    socketTimeout: options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
  });

  return {
    async send(message: EmailMessage): Promise<SendResult> {
      try {
        const info = await transporter.sendMail({
          from: { name: options.fromName, address: options.fromEmail },
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
        });
        const responseCode = responseCodeOf(info);
        return { outcome: 'sent', ...(responseCode === undefined ? {} : { responseCode }) };
      } catch (error) {
        return classifyTransportError(error);
      }
    },

    close() {
      transporter.close();
    },
  };
}
