import { describe, expect, it } from 'vitest';
import {
  buildDateOptions,
  formatSlotDateTime,
  formatSlotTime,
  groupSlotsByMaster,
  parseSlotsPayload,
} from './slots-model';

/** Вымышленные слоты: только идентификаторы и время. */
const masterA = '11111111-1111-4111-8111-111111111111';
const masterB = '22222222-2222-4222-8222-222222222222';

const slot = (masterId: string, startsAt: string) => ({
  masterId,
  startsAt,
  endsAt: new Date(new Date(startsAt).getTime() + 60 * 60 * 1000).toISOString(),
});

describe('parseSlotsPayload', () => {
  it('разбирает ответ по контракту', () => {
    const items = [slot(masterA, '2030-03-04T06:00:00.000Z')];
    expect(parseSlotsPayload({ items })).toEqual(items);
    expect(parseSlotsPayload({ items: [] })).toEqual([]);
  });

  it('возвращает null на ответ не по контракту', () => {
    expect(parseSlotsPayload(null)).toBeNull();
    expect(parseSlotsPayload({})).toBeNull();
    expect(parseSlotsPayload([slot(masterA, '2030-03-04T06:00:00.000Z')])).toBeNull();
    expect(
      parseSlotsPayload({ items: [{ masterId: masterA, startsAt: '2030-03-04 06:00' }] }),
    ).toBeNull();
  });
});

describe('groupSlotsByMaster', () => {
  it('группирует слоты, сохраняя порядок появления мастеров и времени', () => {
    const items = [
      slot(masterB, '2030-03-04T06:00:00.000Z'),
      slot(masterA, '2030-03-04T07:00:00.000Z'),
      slot(masterB, '2030-03-04T08:00:00.000Z'),
    ];

    const groups = groupSlotsByMaster(items);
    expect(groups.map((group) => group.masterId)).toEqual([masterB, masterA]);
    expect(groups[0]?.slots.map((item) => item.startsAt)).toEqual([
      '2030-03-04T06:00:00.000Z',
      '2030-03-04T08:00:00.000Z',
    ]);
    expect(groups[1]?.slots).toHaveLength(1);
  });

  it('на пустом списке отдаёт пустой массив', () => {
    expect(groupSlotsByMaster([])).toEqual([]);
  });
});

describe('buildDateOptions', () => {
  it('начинает с сегодняшней даты в часовом поясе салона', () => {
    // 22:30 UTC — в Москве это уже следующий день.
    const options = buildDateOptions(new Date('2030-03-04T22:30:00.000Z'), 'Europe/Moscow', 3);

    expect(options.map((option) => option.date)).toEqual([
      '2030-03-05',
      '2030-03-06',
      '2030-03-07',
    ]);
    expect(options.every((option) => option.label.length > 0)).toBe(true);
  });

  it('подписывает даты по-русски и без сдвига на поясе машины', () => {
    const [first] = buildDateOptions(new Date('2030-03-04T09:00:00.000Z'), 'Europe/Moscow', 1);
    expect(first?.date).toBe('2030-03-04');
    expect(first?.label).toMatch(/^[А-ЯЁ][а-яё]+, 4 марта$/);
  });

  it('не отдаёт варианты при некорректном количестве дней', () => {
    const now = new Date('2030-03-04T09:00:00.000Z');
    expect(buildDateOptions(now, 'Europe/Moscow', 0)).toEqual([]);
    expect(buildDateOptions(now, 'Europe/Moscow', -5)).toEqual([]);
    expect(buildDateOptions(now, 'Europe/Moscow', Number.NaN)).toEqual([]);
  });
});

describe('formatSlotTime', () => {
  it('показывает время в поясе салона', () => {
    expect(formatSlotTime('2030-03-04T06:00:00.000Z', 'Europe/Moscow')).toBe('09:00');
    expect(formatSlotTime('2030-03-04T06:00:00.000Z', 'UTC')).toBe('06:00');
  });

  it('не падает на некорректной дате', () => {
    expect(formatSlotTime('не дата', 'Europe/Moscow')).toBe('');
  });
});

describe('formatSlotDateTime', () => {
  it('собирает дату и время в одной строке', () => {
    const text = formatSlotDateTime('2030-03-04T06:00:00.000Z', 'Europe/Moscow');
    expect(text).toMatch(/^[А-ЯЁ][а-яё]+, 4 марта, 09:00$/);
  });

  it('не падает на некорректной дате', () => {
    expect(formatSlotDateTime('', 'Europe/Moscow')).toBe('');
  });
});
