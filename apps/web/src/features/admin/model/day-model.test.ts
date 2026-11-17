import { describe, expect, it } from 'vitest';
import {
  adminStatusLabel,
  formatAdminCancelReason,
  formatDayLabel,
  isActiveAdminStatus,
  SALON_CANCEL_PREFIX,
  salonToday,
  shiftDate,
} from './day-model';

/**
 * Тесты дня админки: календарные границы, часовой пояс салона и подписи причин отмены.
 * Данные вымышленные: только даты, статусы и машинные строки причин.
 */

describe('salonToday: дата в часовом поясе салона', () => {
  it('берёт дату по поясу салона, а не по UTC', () => {
    // 21:30 UTC 15 июня — это уже 16 июня в Москве (UTC+3).
    const late = new Date('2030-06-15T21:30:00.000Z');

    expect(salonToday(late, 'Europe/Moscow')).toBe('2030-06-16');
    expect(salonToday(late, 'UTC')).toBe('2030-06-15');
  });

  it('на границе суток переключает день', () => {
    expect(salonToday(new Date('2030-06-15T20:59:59.000Z'), 'Europe/Moscow')).toBe('2030-06-15');
    expect(salonToday(new Date('2030-06-15T21:00:00.000Z'), 'Europe/Moscow')).toBe('2030-06-16');
  });

  it('учитывает переход на летнее время: сутки не равны 24 часам', () => {
    // Москва DST не использует, поэтому проверяем на поясе, где он есть.
    expect(salonToday(new Date('2030-03-31T00:30:00.000Z'), 'Europe/Berlin')).toBe('2030-03-31');
    expect(salonToday(new Date('2030-03-31T22:30:00.000Z'), 'Europe/Berlin')).toBe('2030-04-01');
  });
});

describe('shiftDate: календарная арифметика', () => {
  it('переходит через границу месяца', () => {
    expect(shiftDate('2030-01-31', 1)).toBe('2030-02-01');
    expect(shiftDate('2030-03-01', -1)).toBe('2030-02-28');
    expect(shiftDate('2030-04-30', 1)).toBe('2030-05-01');
  });

  it('переходит через границу года', () => {
    expect(shiftDate('2030-12-31', 1)).toBe('2031-01-01');
    expect(shiftDate('2031-01-01', -1)).toBe('2030-12-31');
  });

  it('правильно считает 29 февраля', () => {
    // 2028 — високосный год.
    expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(shiftDate('2028-02-29', 1)).toBe('2028-03-01');
    expect(shiftDate('2028-03-01', -1)).toBe('2028-02-29');
    // 2027 — не високосный: 28 февраля сразу переходит в март.
    expect(shiftDate('2027-02-28', 1)).toBe('2027-03-01');
  });

  it('шаг на ноль дней возвращает ту же дату', () => {
    expect(shiftDate('2030-06-15', 0)).toBe('2030-06-15');
  });
});

describe('formatDayLabel', () => {
  it('собирает подпись дня без сокращений и без «г.»', () => {
    expect(formatDayLabel('2026-11-17')).toBe('вторник, 17 ноября 2026');
    expect(formatDayLabel('2030-06-15')).toBe('суббота, 15 июня 2030');
  });
});

describe('статусы записи', () => {
  it('подписывает все статусы контракта', () => {
    expect(adminStatusLabel('pending')).toBe('Ждёт подтверждения');
    expect(adminStatusLabel('confirmed')).toBe('Подтверждена');
    expect(adminStatusLabel('cancelled')).toBe('Отменена');
    expect(adminStatusLabel('completed')).toBe('Завершена');
    expect(adminStatusLabel('no_show')).toBe('Не пришёл');
  });

  it('действия доступны только у активных записей', () => {
    expect(isActiveAdminStatus('pending')).toBe(true);
    expect(isActiveAdminStatus('confirmed')).toBe(true);
    expect(isActiveAdminStatus('cancelled')).toBe(false);
    expect(isActiveAdminStatus('completed')).toBe(false);
    expect(isActiveAdminStatus('no_show')).toBe(false);
  });
});

describe('formatAdminCancelReason', () => {
  it('без отмены ничего не показывает', () => {
    expect(formatAdminCancelReason(null)).toBe('');
    expect(formatAdminCancelReason('')).toBe('');
    expect(formatAdminCancelReason('   ')).toBe('');
  });

  it('отсутствие поля (ответ API прежней версии) не отличается от null', () => {
    expect(formatAdminCancelReason(undefined)).toBe('');
  });

  it('объясняет, кто отменил: клиент или салон', () => {
    expect(formatAdminCancelReason('cancelled_by_client')).toBe('Отменена клиентом');
    expect(formatAdminCancelReason(`${SALON_CANCEL_PREFIX}мастер заболел`)).toBe(
      'Отменена салоном: мастер заболел',
    );
  });

  it('причину салона с лишними пробелами показывает аккуратно', () => {
    expect(formatAdminCancelReason('cancelled_by_salon:   клиент просил перенести  ')).toBe(
      'Отменена салоном: клиент просил перенести',
    );
    // Пустой причины салона API не пишет (400 на пустую строку), поэтому вырожденный
    // случай показываем нейтрально, а не «Отменена салоном: ».
    expect(formatAdminCancelReason('cancelled_by_salon:')).toBe('Отменена');
  });

  it('переводит служебные причины оплаты', () => {
    expect(formatAdminCancelReason('payment_expired')).toBe('Отменена: не оплачена вовремя');
    expect(formatAdminCancelReason('payment_canceled')).toBe('Отменена: оплата отменена');
    expect(formatAdminCancelReason('payment_creation_failed')).toBe(
      'Отменена: не удалось создать оплату',
    );
  });

  it('неизвестную причину показывает нейтрально, без технического кода', () => {
    expect(formatAdminCancelReason('cancelled_by_moderator')).toBe('Отменена');
    expect(formatAdminCancelReason('cancelled_by_moderator')).not.toContain('cancelled_by');
  });
});
