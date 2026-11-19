import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { LIMITS } from './config.mjs';
import {
  checkLimitValue,
  describedLimits,
  envNameFor,
  LimitsConfigError,
  readLimitsFile,
  resolveLimits,
} from './limits.mjs';

/**
 * Лимиты цикла из проектного конфига (issue #235): приоритет источников, валидация,
 * наблюдаемость. Файловая система подменяется `readFile` — тесты не зависят от репозитория.
 */
describe('limits: источники и приоритет', () => {
  test('без файла и окружения — дефолты ядра', () => {
    const readFile = () => {
      throw new Error('ENOENT');
    };
    const { values, sources } = resolveLimits({ root: '/nonexistent', env: {}, readFile });

    assert.equal(values.maxCycleCostRub, LIMITS.maxCycleCostRub);
    assert.equal(sources.maxCycleCostRub, 'default');
    assert.equal(values.maxDiffLines, LIMITS.maxDiffLines);
  });

  test('файл проекта перекрывает дефолт, окружение — файл, CLI — окружение', () => {
    const readFile = () => JSON.stringify({ limits: { maxCycleCostRub: 120, maxDiffLines: 3000 } });

    const fromFile = resolveLimits({ root: '/repo', env: {}, readFile });
    assert.equal(fromFile.values.maxCycleCostRub, 120);
    assert.equal(fromFile.sources.maxCycleCostRub, 'config');
    assert.equal(fromFile.values.maxDiffLines, 3000);

    const env = { [envNameFor('maxCycleCostRub')]: '90' };
    const fromEnv = resolveLimits({ root: '/repo', env, readFile });
    assert.equal(fromEnv.values.maxCycleCostRub, 90);
    assert.equal(fromEnv.sources.maxCycleCostRub, 'env');
    // Ключ, которого нет в окружении, по-прежнему берётся из файла.
    assert.equal(fromEnv.sources.maxDiffLines, 'config');

    const fromCli = resolveLimits({ root: '/repo', env, cli: { maxCycleCostRub: 45 }, readFile });
    assert.equal(fromCli.values.maxCycleCostRub, 45);
    assert.equal(fromCli.sources.maxCycleCostRub, 'cli');
  });

  test('нет файла — значения по умолчанию, ошибки нет', () => {
    const { limits } = readLimitsFile('/repo', {
      readFile: () => {
        throw new Error('ENOENT');
      },
    });

    assert.deepEqual(limits, {});
  });
});

describe('limits: валидация', () => {
  test('невалидное значение из файла — ошибка с источником, а не тихий откат', () => {
    const readFile = () => JSON.stringify({ limits: { maxCycleCostRub: -5 } });

    assert.throws(
      () => resolveLimits({ root: '/repo', env: {}, readFile }),
      (error) => error instanceof LimitsConfigError && /maxCycleCostRub/.test(error.message),
    );
  });

  test('дробное значение там, где нужен целый лимит — ошибка', () => {
    assert.throws(() => checkLimitValue('maxDiffLines', 2000.5, 'тест'), LimitsConfigError);
    assert.equal(checkLimitValue('maxCycleCostRub', 12.5, 'тест'), 12.5);
  });

  test('значение вне диапазона и не-число — ошибка', () => {
    assert.throws(() => checkLimitValue('defaultMaxIterations', 0, 'тест'), LimitsConfigError);
    assert.throws(() => checkLimitValue('defaultMaxIterations', 11, 'тест'), LimitsConfigError);
    assert.throws(() => checkLimitValue('maxDiffBytes', 'много', 'тест'), LimitsConfigError);
  });

  test('битый JSON, неизвестный ключ и раздел limits не объектом — ошибка', () => {
    assert.throws(() => readLimitsFile('/repo', { readFile: () => '{не json' }), LimitsConfigError);
    assert.throws(
      () => readLimitsFile('/repo', { readFile: () => JSON.stringify({ limits: { cost: 1 } }) }),
      (error) => error instanceof LimitsConfigError && /неизвестный лимит/.test(error.message),
    );
    assert.throws(
      () => readLimitsFile('/repo', { readFile: () => JSON.stringify({ limits: [] }) }),
      LimitsConfigError,
    );
  });
});

describe('limits: наблюдаемость', () => {
  test('describedLimits перечисляет все лимиты со значением и источником', () => {
    const resolved = resolveLimits({
      root: '/nonexistent',
      env: {},
      readFile: () => {
        throw new Error('ENOENT');
      },
    });
    const described = describedLimits(resolved);

    assert.deepEqual(Object.keys(described).sort(), Object.keys(LIMITS).sort());
    assert.deepEqual(described.maxCycleCostRub, {
      value: LIMITS.maxCycleCostRub,
      source: 'default',
    });
  });

  test('имя переменной окружения строится из ключа', () => {
    assert.equal(envNameFor('maxCycleCostRub'), 'HARNESS_LIMIT_MAX_CYCLE_COST_RUB');
    assert.equal(envNameFor('maxDiffBytes'), 'HARNESS_LIMIT_MAX_DIFF_BYTES');
  });
});
