import { describe, expect, it } from 'vitest';
import { formatDuration, formatPrice } from './format';

/**
 * Intl вставляет неразрывные пробелы (U+00A0) между разрядами и перед знаком валюты.
 * В тестах сравниваем видимый текст: заменяем их на обычный пробел.
 */
function visible(text: string): string {
  return text.replace(/\u00a0|\u202f/g, ' ');
}

describe('formatPrice', () => {
  it('форматирует целые рубли без копеек', () => {
    expect(visible(formatPrice(250000))).toBe('2 500 ₽');
  });

  it('показывает ноль как «0 ₽»', () => {
    expect(visible(formatPrice(0))).toBe('0 ₽');
  });

  it('показывает копейки, если они ненулевые', () => {
    expect(visible(formatPrice(250050))).toBe('2 500,50 ₽');
  });

  it('форматирует крупные суммы с разбивкой по разрядам', () => {
    expect(visible(formatPrice(123456700))).toBe('1 234 567 ₽');
  });

  it('не показывает копейки, если они нулевые', () => {
    expect(visible(formatPrice(99900))).toBe('999 ₽');
  });
});

describe('formatDuration', () => {
  it('форматирует минуты без часов', () => {
    expect(formatDuration(45)).toBe('45 мин');
  });

  it('показывает ровно один час без минут', () => {
    expect(formatDuration(60)).toBe('1 ч');
  });

  it('показывает часы и минуты', () => {
    expect(formatDuration(80)).toBe('1 ч 20 мин');
  });

  it('показывает ровно два часа без минут', () => {
    expect(formatDuration(120)).toBe('2 ч');
  });

  it('не роняет рендер на некорректной длительности', () => {
    expect(formatDuration(0)).toBe('—');
  });
});
