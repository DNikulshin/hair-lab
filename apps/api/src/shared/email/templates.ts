/**
 * Шаблоны писем: контракт между диспетчером (`shared`) и фичами.
 *
 * Реестр шаблонов собирает композиционный корень (`app`) и передаёт его плагину почты:
 * `shared` не импортирует `features`, поэтому зависимость направлена снаружи внутрь.
 * Снимок данных (`payload`) хранится в outbox и рендерится в момент отправки, а не записи.
 */
export interface RenderedEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  /**
   * Момент начала события (записи). Письмо, у которого это время уже прошло,
   * не отправляется: `failed` с причиной `expired` (см. план #9).
   */
  startsAt: Date;
}

export interface EmailTemplate {
  /** Разбор снимка `outbox_messages.payload` и рендер письма. Невалидный снимок — исключение. */
  render(payload: unknown): RenderedEmail;
}

/** Реестр по типу письма (`outbox_messages.type`). Неизвестный тип — `failed`. */
export type EmailTemplateRegistry = Readonly<Record<string, EmailTemplate>>;
