import { z } from 'zod';
import type { EmailTemplate, RenderedEmail } from '../../shared/email';
import type { TokenDeliveryRegistry } from './token-delivery';

/** Outbox type for the one-time email. */
export const MAGIC_LINK_TYPE = 'magic_link';

/** Outbox payload intentionally excludes the raw one-time token. */
export const magicLinkPayloadSchema = z
  .object({
    email: z.email().max(254),
    loginTokenId: z.uuid(),
  })
  .strict();
export type MagicLinkPayload = z.infer<typeof magicLinkPayloadSchema>;

export interface MagicLinkEmailContext {
  appUrl: string;
  fromName: string;
  delivery: TokenDeliveryRegistry;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderMagicLinkEmail(
  payload: unknown,
  context: MagicLinkEmailContext,
  now = new Date(),
): RenderedEmail {
  const data = magicLinkPayloadSchema.parse(payload);
  const delivery = context.delivery.take(data.loginTokenId, now);
  if (delivery === undefined) throw new Error('magic link delivery unavailable');

  const link = new URL('/login/magic', context.appUrl);
  link.searchParams.set('token', delivery.rawToken);
  const href = link.toString();
  const text = [
    'Для входа и подтверждения адреса электронной почты откройте ссылку:',
    href,
    '',
    'Ссылка действует 15 минут. Если вы не запрашивали вход, просто проигнорируйте это письмо.',
    '',
    context.fromName,
  ].join('\n');
  const html = [
    '<!doctype html>',
    '<html lang="ru"><body style="font-family:Arial,sans-serif;font-size:15px;color:#111827">',
    '<p>Для входа и подтверждения адреса электронной почты нажмите на ссылку:</p>',
    `<p><a href="${escapeHtml(href)}">Войти и подтвердить адрес</a></p>`,
    '<p>Ссылка действует 15 минут. Если вы не запрашивали вход, просто проигнорируйте это письмо.</p>',
    `<p>— ${escapeHtml(context.fromName)}</p>`,
    '</body></html>',
  ].join('\n');

  return {
    to: data.email,
    subject: 'Ссылка для входа — Стриж Lab',
    text,
    html,
    startsAt: delivery.expiresAt,
    afterSent: () => context.delivery.remove(data.loginTokenId),
  };
}

export function createMagicLinkTemplate(context: MagicLinkEmailContext): EmailTemplate {
  return { render: (payload) => renderMagicLinkEmail(payload, context) };
}
