import { describe, expect, it } from 'vitest';
import { createMagicLinkTemplate, magicLinkPayloadSchema } from './magic-link.email';
import { createTokenDeliveryRegistry } from './token-delivery';

describe('magic link email', () => {
  it('renders a raw token from process memory and consumes the delivery entry', () => {
    const delivery = createTokenDeliveryRegistry();
    const expiresAt = new Date('2030-01-01T00:15:00.000Z');
    delivery.put('00000000-0000-4000-8000-000000000001', {
      rawToken: 'synthetic-magic-token',
      expiresAt,
    });
    const template = createMagicLinkTemplate({
      appUrl: 'https://example.invalid',
      fromName: 'Тестовый салон',
      delivery,
    });
    const payload = {
      email: 'client@example.invalid',
      loginTokenId: '00000000-0000-4000-8000-000000000001',
    };

    const rendered = template.render(payload);
    expect(rendered.to).toBe(payload.email);
    expect(rendered.text).toContain(
      'https://example.invalid/login/magic?token=synthetic-magic-token',
    );
    expect(rendered.startsAt).toEqual(expiresAt);
    expect(magicLinkPayloadSchema.parse(payload)).toEqual(payload);
    expect(template.render(payload).text).toBe(rendered.text);
    rendered.afterSent?.();
    expect(() => template.render(payload)).toThrow();
  });

  it('rejects outbox payloads with malformed ids or extra raw-token properties', () => {
    expect(() =>
      magicLinkPayloadSchema.parse({
        email: 'client@example.invalid',
        loginTokenId: 'not-a-uuid',
        token: 'must-not-be-persisted',
      }),
    ).toThrow();
  });
});
