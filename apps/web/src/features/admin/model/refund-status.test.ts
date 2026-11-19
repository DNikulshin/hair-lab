import { describe, expect, it } from 'vitest';
import { REFUND_PERIOD_DAYS, refundDefaultPeriod, refundStatusLabel } from './refund-status';

/**
 * Тесты статусов возврата и периода по умолчанию: подписи для сотрудника и календарные
 * границы. Данные вымышленные: только статусы и даты.
 */

describe('refundStatusLabel', () => {
  it('подписывает все три клиентских статуса возврата', () => {
    expect(refundStatusLabel('pending')).toBe('Ожидается возврат');
    expect(refundStatusLabel('failed')).toBe('Возврат не удался');
    expect(refundStatusLabel('succeeded')).toBe('Возвращён');
  });

  it('неизвестный код не роняет рендер', () => {
    // Так выглядел бы статус, добавленный в контракт позже установленной версии web.
    expect(refundStatusLabel('unknown' as never)).toBe('Статус возврата неизвестен');
  });
});

describe('refundDefaultPeriod', () => {
  it('берёт последние 30 дней включительно: `to` — сегодня', () => {
    expect(refundDefaultPeriod('2030-06-30')).toEqual({ from: '2030-06-01', to: '2030-06-30' });
  });

  it('переходит через границу месяца и года по календарю', () => {
    expect(refundDefaultPeriod('2030-03-01')).toEqual({ from: '2030-01-31', to: '2030-03-01' });
    expect(refundDefaultPeriod('2030-01-05')).toEqual({ from: '2029-12-07', to: '2030-01-05' });
  });

  it('период ровно в 30 календарных дней', () => {
    const { from, to } = refundDefaultPeriod('2030-06-30');
    const fromTime = Date.parse(`${from}T00:00:00Z`);
    const toTime = Date.parse(`${to}T00:00:00Z`);

    expect((toTime - fromTime) / (24 * 60 * 60 * 1000) + 1).toBe(REFUND_PERIOD_DAYS);
  });
});
