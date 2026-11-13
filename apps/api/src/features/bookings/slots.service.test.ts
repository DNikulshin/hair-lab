import { describe, expect, it } from 'vitest';
import {
  buildSlots,
  dayOfWeekOf,
  isSlotBookable,
  salonDateOf,
  salonDayWindow,
  type BuildSlotsInput,
} from './slots.service';

/**
 * Чистая генерация слотов: без БД и без текущего времени (всё приходит параметрами).
 * Часовые пояса проверяются на `Europe/Berlin`, чтобы код не был завязан на UTC+3.
 */

const MSK = 'Europe/Moscow';
const BERLIN = 'Europe/Berlin';

/** Полночь UTC календарной даты: «момент до начала дня», чтобы слоты не были в прошлом. */
function midnightUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function baseInput(overrides: Partial<BuildSlotsInput>): BuildSlotsInput {
  return {
    date: '2030-03-04',
    tz: MSK,
    serviceDurationMin: 60,
    workingHours: [],
    exceptions: [],
    appointments: [],
    now: midnightUtc('2030-03-03'),
    ...overrides,
  };
}

/** Начала слотов в ISO: так границы видно без пересчёта часовых поясов в голове. */
function starts(input: BuildSlotsInput): string[] {
  return buildSlots(input).map((slot) => slot.startsAt.toISOString());
}

describe('dayOfWeekOf / salonDayWindow / salonDateOf', () => {
  it('день недели — свойство календарной даты, а не момента времени', () => {
    expect(dayOfWeekOf('2030-03-04')).toBe(1); // понедельник
    expect(dayOfWeekOf('2030-03-31')).toBe(0); // воскресенье
  });

  it('границы дня в поясе с переходом на летнее время: сутки короче на час', () => {
    const window = salonDayWindow('2030-03-31', BERLIN);

    expect(window.startsAt.toISOString()).toBe('2030-03-30T23:00:00.000Z');
    expect(window.endsAt.toISOString()).toBe('2030-03-31T22:00:00.000Z');
    expect(window.endsAt.getTime() - window.startsAt.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it('календарная дата момента времени считается в поясе салона', () => {
    const instant = new Date('2030-03-04T21:30:00.000Z'); // 00:30 следующего дня в Москве

    expect(salonDateOf(instant, MSK)).toBe('2030-03-05');
    expect(salonDateOf(instant, BERLIN)).toBe('2030-03-04');
  });
});

describe('buildSlots: сетка по рабочим часам', () => {
  it('строит сетку с шагом 15 минут внутри смены и не выходит за её конец', () => {
    const input = baseInput({
      workingHours: [{ dayOfWeek: 1, startMinute: 9 * 60, endMinute: 12 * 60 }],
    });
    const result = buildSlots(input);

    // 09:00 МСК = 06:00Z; последний приём на час — 11:00 МСК = 08:00Z.
    expect(starts(input)).toEqual([
      '2030-03-04T06:00:00.000Z',
      '2030-03-04T06:15:00.000Z',
      '2030-03-04T06:30:00.000Z',
      '2030-03-04T06:45:00.000Z',
      '2030-03-04T07:00:00.000Z',
      '2030-03-04T07:15:00.000Z',
      '2030-03-04T07:30:00.000Z',
      '2030-03-04T07:45:00.000Z',
      '2030-03-04T08:00:00.000Z',
    ]);
    expect(result[0]?.endsAt.toISOString()).toBe('2030-03-04T07:00:00.000Z');
    expect(result.at(-1)?.endsAt.toISOString()).toBe('2030-03-04T09:00:00.000Z');
  });

  it('не отдаёт слот, если приём не помещается до конца смены', () => {
    expect(
      starts(
        baseInput({
          serviceDurationMin: 90,
          workingHours: [{ dayOfWeek: 1, startMinute: 9 * 60, endMinute: 10 * 60 }],
        }),
      ),
    ).toEqual([]);

    expect(
      starts(
        baseInput({ workingHours: [{ dayOfWeek: 1, startMinute: 9 * 60, endMinute: 10 * 60 }] }),
      ),
    ).toEqual(['2030-03-04T06:00:00.000Z']);
  });

  it('поддерживает несколько рабочих интервалов в один день', () => {
    expect(
      starts(
        baseInput({
          workingHours: [
            { dayOfWeek: 1, startMinute: 9 * 60, endMinute: 10 * 60 },
            { dayOfWeek: 1, startMinute: 11 * 60, endMinute: 12 * 60 },
          ],
        }),
      ),
    ).toEqual(['2030-03-04T06:00:00.000Z', '2030-03-04T08:00:00.000Z']);
  });

  it('игнорирует рабочие часы другого дня недели и пустой шаблон', () => {
    expect(
      starts(
        baseInput({ workingHours: [{ dayOfWeek: 2, startMinute: 9 * 60, endMinute: 18 * 60 }] }),
      ),
    ).toEqual([]);
    expect(starts(baseInput({}))).toEqual([]);
  });

  it('не отдаёт прошедшее время: действует буфер 30 минут от текущего момента', () => {
    const input = baseInput({
      workingHours: [{ dayOfWeek: 1, startMinute: 9 * 60, endMinute: 12 * 60 }],
      // 09:30 МСК: слоты 09:00–10:00 и раньше уже нельзя, ближайший — 10:00 МСК (07:00Z).
      now: new Date('2030-03-04T06:30:00.000Z'),
    });

    expect(starts(input)[0]).toBe('2030-03-04T07:00:00.000Z');
  });

  it('не отдаёт слоты за пределами горизонта записи', () => {
    expect(
      starts(
        baseInput({
          workingHours: [{ dayOfWeek: 1, startMinute: 9 * 60, endMinute: 12 * 60 }],
          now: new Date('2030-01-01T00:00:00.000Z'),
          horizonDays: 1,
        }),
      ),
    ).toEqual([]);
  });

  it('исключает слоты, пересекающиеся с исключением расписания', () => {
    const input = baseInput({
      workingHours: [{ dayOfWeek: 1, startMinute: 9 * 60, endMinute: 12 * 60 }],
      exceptions: [
        {
          startsAt: new Date('2030-03-04T06:30:00.000Z'),
          endsAt: new Date('2030-03-04T07:30:00.000Z'),
        },
      ],
    });

    // Отпуск 09:30–10:30 МСК: приём 09:00–10:00 пересекается с ним и недоступен,
    // а приём с 10:30 (07:30Z) только касается границы и разрешён.
    expect(starts(input)).toEqual([
      '2030-03-04T07:30:00.000Z',
      '2030-03-04T07:45:00.000Z',
      '2030-03-04T08:00:00.000Z',
    ]);
  });

  it('исключает слоты, пересекающиеся с активной записью мастера', () => {
    const input = baseInput({
      workingHours: [{ dayOfWeek: 1, startMinute: 9 * 60, endMinute: 12 * 60 }],
      appointments: [
        {
          startsAt: new Date('2030-03-04T06:00:00.000Z'),
          endsAt: new Date('2030-03-04T07:00:00.000Z'),
        },
      ],
    });

    expect(starts(input)).toEqual([
      '2030-03-04T07:00:00.000Z',
      '2030-03-04T07:15:00.000Z',
      '2030-03-04T07:30:00.000Z',
      '2030-03-04T07:45:00.000Z',
      '2030-03-04T08:00:00.000Z',
    ]);
  });

  it('отклоняет несуществующую календарную дату и нулевую длительность', () => {
    expect(
      starts(
        baseInput({
          date: '2030-02-31',
          workingHours: [{ dayOfWeek: 6, startMinute: 9 * 60, endMinute: 18 * 60 }],
        }),
      ),
    ).toEqual([]);
    expect(
      starts(
        baseInput({
          serviceDurationMin: 0,
          workingHours: [{ dayOfWeek: 1, startMinute: 9 * 60, endMinute: 18 * 60 }],
        }),
      ),
    ).toEqual([]);
  });
});

describe('buildSlots: переход на летнее и зимнее время', () => {
  it('весенний переход: смена 01:00–04:00 по местному времени длится 2 реальных часа', () => {
    const input = baseInput({
      tz: BERLIN,
      date: '2030-03-31',
      workingHours: [{ dayOfWeek: 0, startMinute: 60, endMinute: 4 * 60 }],
      now: midnightUtc('2030-03-30'),
    });
    const result = buildSlots(input);

    // 01:00 CET = 00:00Z, 04:00 CEST = 02:00Z: в реальном времени между ними 2 часа.
    expect(starts(input)).toEqual([
      '2030-03-31T00:00:00.000Z',
      '2030-03-31T00:15:00.000Z',
      '2030-03-31T00:30:00.000Z',
      '2030-03-31T00:45:00.000Z',
      '2030-03-31T01:00:00.000Z',
    ]);
    expect(result.at(-1)?.endsAt.toISOString()).toBe('2030-03-31T02:00:00.000Z');
  });

  it('осенний переход: смена 01:00–04:00 по местному времени длится 4 реальных часа', () => {
    const input = baseInput({
      tz: BERLIN,
      date: '2030-10-27',
      workingHours: [{ dayOfWeek: 0, startMinute: 60, endMinute: 4 * 60 }],
      now: midnightUtc('2030-10-26'),
    });
    const result = buildSlots(input);

    expect(result).toHaveLength(13);
    expect(result[0]?.startsAt.toISOString()).toBe('2030-10-26T23:00:00.000Z');
    expect(result.at(-1)?.startsAt.toISOString()).toBe('2030-10-27T02:00:00.000Z');
    expect(result.at(-1)?.endsAt.toISOString()).toBe('2030-10-27T03:00:00.000Z');
  });

  it('обычная смена в другом поясе считается по местному времени салона, не по UTC', () => {
    expect(
      starts(
        baseInput({
          tz: BERLIN,
          date: '2030-03-04',
          workingHours: [{ dayOfWeek: 1, startMinute: 9 * 60, endMinute: 10 * 60 }],
        }),
      ),
    ).toEqual(['2030-03-04T08:00:00.000Z']);
  });
});

describe('isSlotBookable', () => {
  const schedule = {
    workingHours: [{ dayOfWeek: 1, startMinute: 9 * 60, endMinute: 12 * 60 }],
    exceptions: [],
    appointments: [],
  };
  const base = {
    ...schedule,
    date: '2030-03-04',
    tz: MSK,
    now: midnightUtc('2030-03-03'),
  };

  it('пропускает интервал внутри смены и отклоняет выход за её границы', () => {
    expect(
      isSlotBookable({
        ...base,
        startsAt: new Date('2030-03-04T06:00:00.000Z'),
        endsAt: new Date('2030-03-04T07:00:00.000Z'),
      }),
    ).toBe(true);

    expect(
      isSlotBookable({
        ...base,
        startsAt: new Date('2030-03-04T08:30:00.000Z'),
        endsAt: new Date('2030-03-04T09:30:00.000Z'),
      }),
    ).toBe(false);
  });

  it('отклоняет прошедшее время и перевёрнутый интервал', () => {
    expect(
      isSlotBookable({
        ...base,
        startsAt: new Date('2030-03-04T05:45:00.000Z'),
        endsAt: new Date('2030-03-04T06:45:00.000Z'),
        now: new Date('2030-03-04T06:00:00.000Z'),
      }),
    ).toBe(false);

    expect(
      isSlotBookable({
        ...base,
        startsAt: new Date('2030-03-04T07:00:00.000Z'),
        endsAt: new Date('2030-03-04T07:00:00.000Z'),
      }),
    ).toBe(false);
  });

  it('отклоняет интервал в день без рабочих часов', () => {
    expect(
      isSlotBookable({
        ...base,
        workingHours: [],
        startsAt: new Date('2030-03-04T06:00:00.000Z'),
        endsAt: new Date('2030-03-04T07:00:00.000Z'),
      }),
    ).toBe(false);
  });
});
