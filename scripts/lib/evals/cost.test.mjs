import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  STAGES,
  applyDelta,
  formatDelta,
  formatRub,
  priceCycle,
  priceStage,
  readCandidates,
  readPrices,
  readProfiles,
  roundRub,
} from './cost.mjs';

/** Минимальный снапшот: две модели с разными ценами. */
function pricesDoc() {
  return {
    _meta: { currency: 'RUB' },
    models: {
      'z-ai/glm-5.3': {
        input: 8,
        output: 100,
        cache_read: 10,
        cache_write: 0,
        context: 1000,
      },
      'openai/gpt-6-luna-pro': {
        input: 6,
        output: 30,
        cache_read: 0.5,
        cache_write: 0,
        context: 1000,
      },
    },
  };
}

/** Профиль на 1M токенов каждого вида — арифметика проверяется в уме. */
function profile(input, cacheRead, output, reasoning = 0) {
  return { calls_per_run: 1, input, cache_read: cacheRead, output, reasoning };
}

function profilesDoc() {
  return {
    stages: {
      plan: profile(1_000_000, 1_000_000, 1_000_000, 800_000),
      code: profile(0, 0, 0),
      review: profile(0, 0, 0),
      evaluate: profile(0, 0, 0),
    },
  };
}

describe('readPrices', () => {
  test('принимает корректный снапшот и подставляет нули для необязательных полей', () => {
    const { models } = readPrices({
      models: { 'x/y': { input: 1, output: 2, cache_read: 3 } },
    });
    assert.deepEqual(models['x/y'], {
      input: 1,
      output: 2,
      cache_read: 3,
      cache_write: 0,
      context: 0,
    });
  });

  test('отказывает на чужой валюте: расчёт идёт только в рублях', () => {
    assert.throws(
      () => readPrices({ _meta: { currency: 'USD' }, models: pricesDoc().models }),
      /currency/u,
    );
  });

  test('отказывает на строковой цене и на пустом снапшоте', () => {
    assert.throws(() => readPrices({ models: { 'x/y': { input: '6', output: 2 } } }), /input/u);
    assert.throws(() => readPrices({ models: {} }), /пустой/u);
  });
});

describe('readProfiles', () => {
  test('требует профиль каждой стадии цикла', () => {
    const doc = profilesDoc();
    delete doc.stages.review;
    assert.throws(() => readProfiles(doc), /profiles\.stages\.review/u);
  });

  test('перечисляет все стадии в STAGES', () => {
    assert.deepEqual([...STAGES], ['plan', 'code', 'review', 'evaluate']);
  });
});

describe('readCandidates', () => {
  test('разбирает дельту и пропускает пояснение', () => {
    const candidates = readCandidates({
      candidates: { 'eval-flash': { note: 'дешевле', evaluate: 'z-ai/glm-5.3-flash' } },
    });
    assert.deepEqual(candidates['eval-flash'], {
      note: 'дешевле',
      models: { evaluate: 'z-ai/glm-5.3-flash' },
    });
  });

  test('отказывает на неизвестной стадии и на пустом кандидате', () => {
    assert.throws(
      () => readCandidates({ candidates: { a: { deploy: 'x/y' } } }),
      /неизвестная стадия/u,
    );
    assert.throws(() => readCandidates({ candidates: { a: { note: 'ничего' } } }), /не меняет/u);
  });
});

describe('applyDelta', () => {
  test('меняет только указанные стадии', () => {
    const base = { plan: 'p', code: 'c', review: 'r', evaluate: 'e' };
    assert.deepEqual(applyDelta(base, { evaluate: 'x' }), {
      plan: 'p',
      code: 'c',
      review: 'r',
      evaluate: 'x',
    });
    assert.deepEqual(base, { plan: 'p', code: 'c', review: 'r', evaluate: 'e' });
  });
});

describe('priceStage', () => {
  test('считает вход, кэш и вывод по своим ценам', () => {
    const { models } = readPrices(pricesDoc());
    const cost = priceStage(
      { prices: models },
      'z-ai/glm-5.3',
      profile(1_000_000, 1_000_000, 1_000_000, 800_000),
    );

    assert.equal(cost.input, 8);
    assert.equal(cost.cache_read, 10);
    assert.equal(cost.output, 100);
    assert.equal(cost.total, 118);
    assert.equal(cost.reasoning_share, 0.8);
  });

  test('вывод дешевле по цене не значит дешевле по прогону: кэш считается отдельно', () => {
    const { models } = readPrices(pricesDoc());
    const heavyCache = profile(0, 10_000_000, 1_000_000);
    const cheap = priceStage({ prices: models }, 'openai/gpt-6-luna-pro', heavyCache);
    const dear = priceStage({ prices: models }, 'z-ai/glm-5.3', heavyCache);

    assert.ok(cheap.total < dear.total);
    assert.equal(cheap.total, 35);
    assert.equal(dear.total, 200);
  });

  test('модели нет в снапшоте — исключение, а не NaN в отчёте', () => {
    const { models } = readPrices(pricesDoc());
    assert.throws(
      () => priceStage({ prices: models }, 'nope/nope', profile(1, 1, 1)),
      /нет в снапшоте/u,
    );
  });

  test('нулевой профиль не даёт деления на ноль', () => {
    const { models } = readPrices(pricesDoc());
    assert.equal(
      priceStage({ prices: models }, 'z-ai/glm-5.3', profile(0, 0, 0)).reasoning_share,
      0,
    );
  });
});

describe('priceCycle', () => {
  test('складывает четыре стадии и требует модель каждой', () => {
    const { models } = readPrices(pricesDoc());
    const { stages } = readProfiles(profilesDoc());
    const cycle = priceCycle(
      { prices: models, profiles: stages },
      {
        plan: 'z-ai/glm-5.3',
        code: 'openai/gpt-6-luna-pro',
        review: 'openai/gpt-6-luna-pro',
        evaluate: 'openai/gpt-6-luna-pro',
      },
    );
    assert.equal(cycle.stages.plan.total, 118);
    assert.equal(cycle.stages.code.total, 0);
    assert.equal(cycle.total, 118);

    assert.throws(
      () =>
        priceCycle(
          { prices: models, profiles: stages },
          { plan: 'z-ai/glm-5.3', code: '', review: 'r', evaluate: 'e' },
        ),
      /не задана модель стадии code/u,
    );
  });
});

describe('форматирование', () => {
  test('округление до копеек и -0', () => {
    assert.equal(roundRub(6.2295), 6.23);
    assert.equal(roundRub(-0.001), 0);
    assert.equal(formatRub(14.9279), '14.93');
    assert.equal(formatRub(0), '0.00');
  });

  test('дельта со знаком', () => {
    assert.equal(formatDelta(-8.1599), '-8.16');
    assert.equal(formatDelta(0.4), '+0.40');
    assert.equal(formatDelta(0), '0.00');
  });
});
