import type { BookingStatus, RefundClientStatus } from '@hair-lab/contracts';
import { describe, expect, it } from 'vitest';
import { bookingStatusLabel, isActiveStatus, refundStatusLabel } from './account-status';

/**
 * Подписи статусов: `awaitingPayment` отличает «ждёт оплаты» от «ждёт подтверждения салона».
 * Строки проверяются дословно — это клиентский текст, он важен не меньше логики.
 */

describe('bookingStatusLabel', () => {
  it('pending с ожиданием оплаты — «Ждёт оплаты»', () => {
    expect(bookingStatusLabel('pending', true)).toBe('Ждёт оплаты');
  });

  it('pending без признака оплаты (PAYMENTS_MODE=off или старый API) — прежняя подпись', () => {
    expect(bookingStatusLabel('pending')).toBe('Ждёт подтверждения');
    expect(bookingStatusLabel('pending', false)).toBe('Ждёт подтверждения');
  });

  it('признак оплаты не меняет остальные статусы', () => {
    expect(bookingStatusLabel('confirmed', true)).toBe('Подтверждена');
    expect(bookingStatusLabel('cancelled', true)).toBe('Отменена');
    expect(bookingStatusLabel('completed', true)).toBe('Завершена');
    expect(bookingStatusLabel('no_show', true)).toBe('Неявка');
  });

  it('неизвестный код не роняет рендер', () => {
    expect(bookingStatusLabel('unknown' as BookingStatus)).toBe('Статус неизвестен');
  });
});

describe('isActiveStatus', () => {
  it('активны только pending и confirmed', () => {
    expect(isActiveStatus('pending')).toBe(true);
    expect(isActiveStatus('confirmed')).toBe(true);
    expect(isActiveStatus('cancelled')).toBe(false);
    expect(isActiveStatus('completed')).toBe(false);
    expect(isActiveStatus('no_show')).toBe(false);
  });
});

describe('refundStatusLabel', () => {
  it('возврат в пути: тот же срок, что в письме и на странице оплаты', () => {
    expect(refundStatusLabel('pending')).toBe('Возврат на карту — до 3 рабочих дней.');
  });

  it('деньги вернулись', () => {
    expect(refundStatusLabel('succeeded')).toBe('Деньги за запись возвращены.');
  });

  it('возврат не удался: клиенту есть куда позвонить', () => {
    expect(refundStatusLabel('failed')).toBe('Возврат не удался — позвоните в салон.');
  });

  it('новый статус от API не роняет рендер', () => {
    expect(refundStatusLabel('processing' as RefundClientStatus)).toBe('');
  });
});
