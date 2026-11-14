import { describe, expect, it } from 'vitest';
import type { BookingStatus, PaymentStatus } from '@hair-lab/contracts';
import type { PaymentDraft } from './payment-draft';
import { formatRemaining, resolvePaymentState, type PaymentView } from './payment-state';

/** Вымышленные значения: реальных записей и ссылок в тестах быть не должно. */
const APPOINTMENT_ID = '0b9c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
const CONFIRMATION_URL = 'https://yoomoney.test/checkout/payment/example-1';

/** Момент «сейчас» фиксирован: таймер и состояния от него считаются детерминированно. */
const NOW = Date.parse('2030-03-04T10:00:00.000Z');

/** Черновик с холдом на 15 минут вперёд от `NOW`. */
const DRAFT: PaymentDraft = {
  appointmentId: APPOINTMENT_ID,
  confirmationUrl: CONFIRMATION_URL,
  expiresAt: '2030-03-04T10:15:00.000Z',
};

function draftExpiredBy(ms: number): PaymentDraft {
  return { ...DRAFT, expiresAt: new Date(NOW - ms).toISOString() };
}

function ready(status: PaymentStatus, appointmentStatus: BookingStatus): PaymentView {
  return { kind: 'ready', status, appointmentStatus };
}

describe('resolvePaymentState: загрузка и ошибки запроса', () => {
  it('загрузка: ни опроса, ни таймера, ни кнопок', () => {
    const state = resolvePaymentState({ view: { kind: 'loading' }, draft: DRAFT, now: NOW });

    expect(state.kind).toBe('loading');
    expect(state.title).not.toBe('');
    expect(state.shouldPoll).toBe(false);
    expect(state.terminal).toBe(false);
    expect(state.retryable).toBe(false);
    expect(state.remainingLabel).toBeNull();
    expect(state.paymentUrl).toBeNull();
  });

  it('404 (в том числе PAYMENTS_MODE=off): «оплата не найдена», черновик не нужен', () => {
    const state = resolvePaymentState({ view: { kind: 'notFound' }, draft: DRAFT, now: NOW });

    expect(state.kind).toBe('notFound');
    expect(state.terminal).toBe(true);
    expect(state.shouldPoll).toBe(false);
    expect(state.retryable).toBe(false);
    expect(state.paymentUrl).toBeNull();
  });

  it('сеть или 5xx: предлагаем проверить ещё раз, черновик сохраняем', () => {
    const state = resolvePaymentState({ view: { kind: 'unavailable' }, draft: DRAFT, now: NOW });

    expect(state.kind).toBe('unavailable');
    expect(state.retryable).toBe(true);
    expect(state.terminal).toBe(false);
    expect(state.shouldPoll).toBe(false);
  });
});

describe('resolvePaymentState: ждём оплату', () => {
  it('pending у pending-записи: таймер холда, ссылка провайдера, опрос', () => {
    const state = resolvePaymentState({
      view: ready('pending', 'pending'),
      draft: DRAFT,
      now: NOW,
    });

    expect(state.kind).toBe('pending');
    expect(state.remainingMs).toBe(15 * 60 * 1000);
    expect(state.remainingLabel).toBe('15:00');
    expect(state.paymentUrl).toBe(CONFIRMATION_URL);
    expect(state.shouldPoll).toBe(true);
    expect(state.terminal).toBe(false);
    expect(state.retryable).toBe(false);
  });

  it('таймер идёт: остаток пересчитывается по часам клиента', () => {
    const state = resolvePaymentState({
      view: ready('pending', 'pending'),
      draft: DRAFT,
      now: NOW + 61_000,
    });

    expect(state.remainingLabel).toBe('13:59');
    expect(state.remainingMs).toBe(14 * 60 * 1000 - 1000);
  });

  it('клиентские часы просрочили холд: ссылка остаётся, опрос идёт, текст про проверку статуса', () => {
    const state = resolvePaymentState({
      view: ready('pending', 'pending'),
      draft: draftExpiredBy(1_000),
      now: NOW,
    });

    expect(state.kind).toBe('pending');
    expect(state.remainingMs).toBe(0);
    // «Действует ещё 00:00» противоречило бы тексту: на нуле таймер молчит.
    expect(state.remainingLabel).toBeNull();
    // Сбитые часы не отнимают возможность заплатить: ссылку скрывает только сервер.
    expect(state.paymentUrl).toBe(CONFIRMATION_URL);
    expect(state.description).toContain('проверяем статус');
    expect(state.shouldPoll).toBe(true);
    expect(state.terminal).toBe(false);
  });

  it('часы убежали далеко вперёд: ссылка и опрос те же, что при живом таймере', () => {
    const state = resolvePaymentState({
      view: ready('pending', 'pending'),
      draft: draftExpiredBy(60 * 60 * 1000),
      now: NOW,
    });

    expect(state.paymentUrl).toBe(CONFIRMATION_URL);
    expect(state.shouldPoll).toBe(true);
  });

  it('без черновика (новая вкладка): таймера и ссылки нет, опрос есть', () => {
    const state = resolvePaymentState({
      view: ready('pending', 'pending'),
      draft: null,
      now: NOW,
    });

    expect(state.kind).toBe('pending');
    expect(state.remainingMs).toBeNull();
    expect(state.remainingLabel).toBeNull();
    expect(state.paymentUrl).toBeNull();
    expect(state.description).toContain('в той же вкладке');
    expect(state.shouldPoll).toBe(true);
  });

  it('битый срок в черновике: таймер не показываем, ссылку оставляем', () => {
    const state = resolvePaymentState({
      view: ready('pending', 'pending'),
      draft: { ...DRAFT, expiresAt: 'не дата' },
      now: NOW,
    });

    expect(state.remainingMs).toBeNull();
    expect(state.remainingLabel).toBeNull();
    expect(state.paymentUrl).toBe(CONFIRMATION_URL);
  });

  it('запись уже подтверждена салоном: ссылка есть, опрос не нужен', () => {
    const state = resolvePaymentState({
      view: ready('pending', 'confirmed'),
      draft: DRAFT,
      now: NOW,
    });

    expect(state.kind).toBe('pending');
    expect(state.paymentUrl).toBe(CONFIRMATION_URL);
    expect(state.shouldPoll).toBe(false);
  });

  it('pending-платёж у отменённой записи (истёк холд): отмена, ссылки нет', () => {
    const state = resolvePaymentState({
      view: ready('pending', 'cancelled'),
      draft: DRAFT,
      now: NOW,
    });

    expect(state.kind).toBe('canceled');
    expect(state.shouldPoll).toBe(false);
    expect(state.terminal).toBe(true);
    expect(state.paymentUrl).toBeNull();
  });
});

describe('resolvePaymentState: результаты оплаты', () => {
  it('succeeded + подтверждённая запись: оплачено', () => {
    const state = resolvePaymentState({
      view: ready('succeeded', 'confirmed'),
      draft: DRAFT,
      now: NOW,
    });

    expect(state.kind).toBe('paid');
    expect(state.terminal).toBe(true);
    expect(state.shouldPoll).toBe(false);
    expect(state.remainingLabel).toBeNull();
    expect(state.paymentUrl).toBeNull();
  });

  it.each(['completed', 'no_show'] as const)(
    'succeeded + %s: деньги получены, возврат не нужен',
    (appointmentStatus) => {
      const state = resolvePaymentState({
        view: ready('succeeded', appointmentStatus),
        draft: DRAFT,
        now: NOW,
      });

      expect(state.kind).toBe('paid');
      expect(state.terminal).toBe(true);
    },
  );

  it('succeeded + отменённая запись: возврат в пути', () => {
    const state = resolvePaymentState({
      view: ready('succeeded', 'cancelled'),
      draft: DRAFT,
      now: NOW,
    });

    expect(state.kind).toBe('refundPending');
    expect(state.terminal).toBe(true);
    expect(state.shouldPoll).toBe(false);
  });

  it('canceled: оплата не состоялась, ссылки нет', () => {
    const state = resolvePaymentState({
      view: ready('canceled', 'cancelled'),
      draft: DRAFT,
      now: NOW,
    });

    expect(state.kind).toBe('canceled');
    expect(state.terminal).toBe(true);
    expect(state.shouldPoll).toBe(false);
    // Ссылку прячет только серверный статус, даже если холд по клиентским часам ещё жив.
    expect(state.paymentUrl).toBeNull();
  });

  it('refunded: деньги возвращены', () => {
    const state = resolvePaymentState({
      view: ready('refunded', 'cancelled'),
      draft: DRAFT,
      now: NOW,
    });

    expect(state.kind).toBe('refunded');
    expect(state.terminal).toBe(true);
    expect(state.shouldPoll).toBe(false);
  });
});

describe('resolvePaymentState: черновик чистят только терминальные состояния', () => {
  const cases: ReadonlyArray<readonly [PaymentView, boolean]> = [
    [{ kind: 'loading' }, false],
    [{ kind: 'unavailable' }, false],
    [ready('pending', 'pending'), false],
    [ready('pending', 'confirmed'), false],
    [ready('succeeded', 'confirmed'), true],
    [ready('succeeded', 'cancelled'), true],
    [ready('canceled', 'cancelled'), true],
    [ready('refunded', 'cancelled'), true],
    [{ kind: 'notFound' }, true],
  ];

  it.each(cases)('%o → terminal=%s', (view, terminal) => {
    const state = resolvePaymentState({ view, draft: DRAFT, now: NOW });

    expect(state.terminal).toBe(terminal);
  });

  it('у каждого состояния есть заголовок', () => {
    for (const [view] of cases) {
      expect(resolvePaymentState({ view, draft: DRAFT, now: NOW }).title.length).toBeGreaterThan(0);
    }
  });
});

describe('formatRemaining', () => {
  it.each([
    [15 * 60 * 1000, '15:00'],
    [61_000, '01:01'],
    [59_500, '01:00'],
    [1, '00:01'],
    [0, '00:00'],
    [-5_000, '00:00'],
  ])('%d мс → %s', (ms, label) => {
    expect(formatRemaining(ms)).toBe(label);
  });
});
