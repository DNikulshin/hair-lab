import { describe, expect, it } from 'vitest';
import {
  clampPosition,
  DEFAULT_POSITION,
  isDragGesture,
  parseStoredPosition,
  serializePosition,
} from './deploy-badge-position';

const VIEWPORT = { width: 390, height: 844 };
const SIZE = { width: 150, height: 18 };

describe('clampPosition', () => {
  it('оставляет позицию внутри окна без изменений', () => {
    expect(clampPosition({ x: 40, y: 120 }, VIEWPORT, SIZE)).toEqual({ x: 40, y: 120 });
  });

  it('не даёт уехать за правый и нижний край', () => {
    expect(clampPosition({ x: 10_000, y: 10_000 }, VIEWPORT, SIZE)).toEqual({
      x: 390 - 150 - 4,
      y: 844 - 18 - 4,
    });
  });

  it('не даёт уехать за левый и верхний край', () => {
    expect(clampPosition({ x: -500, y: -500 }, VIEWPORT, SIZE)).toEqual({ x: 4, y: 4 });
  });

  it('при окне меньше плашки фиксирует левый верхний угол — плашку можно вернуть', () => {
    const tiny = { width: 100, height: 10 };
    expect(clampPosition({ x: 50, y: 50 }, tiny, SIZE)).toEqual({ x: 4, y: 4 });
  });

  it('позиция по умолчанию не сдвигается на обычном экране', () => {
    expect(clampPosition(DEFAULT_POSITION, VIEWPORT, SIZE)).toEqual(DEFAULT_POSITION);
  });
});

describe('parseStoredPosition', () => {
  it('читает позицию, записанную serializePosition', () => {
    expect(parseStoredPosition(serializePosition({ x: 12.4, y: 88.6 }))).toEqual({ x: 12, y: 89 });
  });

  it('мусор, пустое значение и чужой JSON — null', () => {
    expect(parseStoredPosition(null)).toBeNull();
    expect(parseStoredPosition('')).toBeNull();
    expect(parseStoredPosition('   ')).toBeNull();
    expect(parseStoredPosition('{')).toBeNull();
    expect(parseStoredPosition('[1,2]')).toBeNull();
    expect(parseStoredPosition('"12,24"')).toBeNull();
    expect(parseStoredPosition('{"x":1}')).toBeNull();
    expect(parseStoredPosition('{"x":"a","y":2}')).toBeNull();
  });

  it('нецелые координаты округляет, а не отбрасывает', () => {
    expect(parseStoredPosition('{"x":10.6,"y":0}')).toEqual({ x: 11, y: 0 });
  });
});

describe('isDragGesture', () => {
  it('мелкий сдвиг — это клик', () => {
    expect(isDragGesture(0, 0)).toBe(false);
    expect(isDragGesture(6, -6)).toBe(false);
  });

  it('сдвиг больше порога — перетаскивание', () => {
    expect(isDragGesture(7, 0)).toBe(true);
    expect(isDragGesture(0, -7)).toBe(true);
    expect(isDragGesture(-20, 3)).toBe(true);
  });
});
