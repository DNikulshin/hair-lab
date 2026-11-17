/**
 * Стоимость прогона стадии и цикла по ценам провайдера (docs/evals.md).
 *
 * Модуль только считает: файлов не читает и не пишет, время и случайность не использует.
 * Входные документы (`prices.json`, `profiles.json`, `candidates.json`) разбираются
 * валидаторами этого же модуля — битые числа должны ломать расчёт, а не давать `NaN`
 * в отчёте, по которому принимают решение о деньгах.
 *
 * Модель расчёта повторяет то, как провайдер тарифицирует запрос: свежий вход, чтение
 * кэша и вывод считаются по своим ценам, а `reasoning` входит в `output` (отдельной
 * цены у рассуждений нет). Поэтому профиль стадии — это три числа, а не четыре:
 * `reasoning` хранится рядом для диагностики «сколько вывода — это размышления».
 *
 * Цены — в рублях за 1M токенов, как их отдаёт каталог провайдера. Никаких курсов
 * внутри нет: если провайдер отдаёт другую валюту, снапшот `prices.json` непригоден,
 * и `currency` из `_meta` обязан это показать.
 *
 * Shebang не нужен: модуль подключается из CLI-скриптов `evals-*.mjs`.
 */

/** Стадии, которые считаются в цикле. Порядок — порядок этапов автомата §5.3. */
export const STAGES = Object.freeze(['plan', 'code', 'review', 'evaluate']);

/** Ожидаемая валюта снапшота цен: расчёт в рублях, курс внутри модуля не живёт. */
export const CURRENCY = 'RUB';

/**
 * @typedef {object} ModelPrice
 * @property {number} input ₽ за 1M токенов свежего входа
 * @property {number} output ₽ за 1M токенов вывода (включая рассуждения)
 * @property {number} cache_read ₽ за 1M токенов чтения кэша
 * @property {number} cache_write ₽ за 1M токенов записи кэша
 * @property {number} context длина контекста в токенах
 */

/**
 * @typedef {object} StageProfile
 * @property {number} calls_per_run вызовов модели на прогон стадии
 * @property {number} input токенов свежего входа на прогон
 * @property {number} cache_read токенов чтения кэша на прогон
 * @property {number} output токенов вывода на прогон (включая рассуждения)
 * @property {number} reasoning токенов рассуждений на прогон (часть `output`)
 */

/**
 * @typedef {object} StageCost
 * @property {string} model идентификатор модели из `prices.json`
 * @property {number} input ₽ за свежий вход
 * @property {number} cache_read ₽ за чтение кэша
 * @property {number} output ₽ за вывод
 * @property {number} total сумма, ₽
 * @property {number} reasoning_share доля вывода, приходящаяся на рассуждения (0…1)
 */

/** Плоский объект: массивы и `null` объектами не считаются. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Неотрицательное конечное число. Строки не принимаются: в JSON-снапшоте цены —
 * числа, а «6.07» строкой означало бы ошибку генерации снапшота, которую надо увидеть.
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function reqNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label}: ожидается число ≥ 0`);
  }
  return value;
}

/**
 * Проверяет снапшот цен и возвращает его как есть (без копирования: модуль не мутирует).
 * @param {unknown} doc содержимое `evals/prices.json`
 * @returns {{ models: Record<string, ModelPrice>, meta: Record<string, unknown> }}
 */
export function readPrices(doc) {
  if (!isRecord(doc)) throw new Error('prices: ожидается объект');
  if (!isRecord(doc.models)) throw new Error('prices.models: ожидается объект моделей');

  const meta = isRecord(doc._meta) ? doc._meta : {};
  if (typeof meta.currency === 'string' && meta.currency !== CURRENCY) {
    throw new Error(`prices._meta.currency: ожидается ${CURRENCY}, получено ${meta.currency}`);
  }

  /** @type {Record<string, ModelPrice>} */
  const models = {};
  for (const [id, value] of Object.entries(doc.models)) {
    const label = `prices.models["${id}"]`;
    if (!isRecord(value)) throw new Error(`${label}: ожидается объект`);
    models[id] = {
      input: reqNumber(value.input, `${label}.input`),
      output: reqNumber(value.output, `${label}.output`),
      cache_read: reqNumber(value.cache_read, `${label}.cache_read`),
      cache_write: reqNumber(value.cache_write ?? 0, `${label}.cache_write`),
      context: reqNumber(value.context ?? 0, `${label}.context`),
    };
  }

  if (Object.keys(models).length === 0) throw new Error('prices.models: пустой снапшот');
  return { models, meta };
}

/**
 * Проверяет профили нагрузки. Профиль — приближение: при смене модели меняется и
 * длина ответа, поэтому числа описывают стадию, а не модель.
 * @param {unknown} doc содержимое `evals/profiles.json`
 * @returns {{ stages: Record<string, StageProfile>, meta: Record<string, unknown> }}
 */
export function readProfiles(doc) {
  if (!isRecord(doc)) throw new Error('profiles: ожидается объект');
  if (!isRecord(doc.stages)) throw new Error('profiles.stages: ожидается объект стадий');

  /** @type {Record<string, StageProfile>} */
  const stages = {};
  for (const [stage, value] of Object.entries(doc.stages)) {
    const label = `profiles.stages.${stage}`;
    if (!isRecord(value)) throw new Error(`${label}: ожидается объект`);
    stages[stage] = {
      calls_per_run: reqNumber(value.calls_per_run, `${label}.calls_per_run`),
      input: reqNumber(value.input, `${label}.input`),
      cache_read: reqNumber(value.cache_read, `${label}.cache_read`),
      output: reqNumber(value.output, `${label}.output`),
      reasoning: reqNumber(value.reasoning ?? 0, `${label}.reasoning`),
    };
  }

  for (const stage of STAGES) {
    if (!Object.hasOwn(stages, stage)) throw new Error(`profiles.stages.${stage}: нет профиля`);
  }
  return { stages, meta: isRecord(doc._meta) ? doc._meta : {} };
}

/**
 * Дельты кандидатов: имя → набор стадий с моделями. Не указанная стадия берётся
 * из текущей конфигурации, поэтому кандидат — это эксперимент, а не второй конфиг.
 * @param {unknown} doc содержимое `evals/candidates.json`
 * @returns {Record<string, { note: string, models: Record<string, string> }>}
 */
export function readCandidates(doc) {
  if (!isRecord(doc) || !isRecord(doc.candidates)) {
    throw new Error('candidates.candidates: ожидается объект кандидатов');
  }

  /** @type {Record<string, { note: string, models: Record<string, string> }>} */
  const candidates = {};
  for (const [name, value] of Object.entries(doc.candidates)) {
    const label = `candidates.${name}`;
    if (!isRecord(value)) throw new Error(`${label}: ожидается объект`);
    /** @type {Record<string, string>} */
    const models = {};
    for (const [stage, model] of Object.entries(value)) {
      if (stage === 'note') continue;
      if (!STAGES.includes(stage)) {
        throw new Error(`${label}.${stage}: неизвестная стадия, ожидается ${STAGES.join('|')}`);
      }
      if (typeof model !== 'string' || model.trim() === '') {
        throw new Error(`${label}.${stage}: ожидается идентификатор модели`);
      }
      models[stage] = model.trim();
    }
    if (Object.keys(models).length === 0) {
      throw new Error(`${label}: кандидат не меняет ни одной стадии`);
    }
    candidates[name] = { note: typeof value.note === 'string' ? value.note : '', models };
  }
  return candidates;
}

/**
 * Наложение дельты кандидата на текущую конфигурацию.
 * @param {Record<string, string>} base модели по стадиям
 * @param {Record<string, string>} delta изменения
 * @returns {Record<string, string>} новая конфигурация
 */
export function applyDelta(base, delta) {
  const result = { ...base };
  for (const [stage, model] of Object.entries(delta)) result[stage] = model;
  return result;
}

/**
 * Стоимость одного прогона стадии. Проверка наличия модели и профиля — здесь, а не
 * в вызывающем коде: `undefined` в расчёте дал бы `NaN` в отчёте.
 * @param {{ prices: Record<string, ModelPrice> }} source проверенный снапшот
 * @param {string} model идентификатор модели
 * @param {StageProfile} profile профиль стадии
 * @returns {StageCost}
 */
export function priceStage({ prices }, model, profile) {
  const price = prices[model];
  if (price === undefined) {
    throw new Error(`модели нет в снапшоте цен: ${model} (обновите evals/prices.json)`);
  }

  const input = (profile.input * price.input) / 1e6;
  const cacheRead = (profile.cache_read * price.cache_read) / 1e6;
  const output = (profile.output * price.output) / 1e6;

  return {
    model,
    input,
    cache_read: cacheRead,
    output,
    total: input + cacheRead + output,
    reasoning_share: profile.output === 0 ? 0 : profile.reasoning / profile.output,
  };
}

/**
 * Стоимость полного цикла: по одному прогону каждой стадии. Дополнительные итерации
 * `code` считаются отдельно вызывающим кодом: они зависят от исхода, а не от цен.
 * @param {{ prices: Record<string, ModelPrice>, profiles: Record<string, StageProfile> }} input
 * @param {Record<string, string>} models модели по стадиям
 * @returns {{ stages: Record<string, StageCost>, total: number }}
 */
export function priceCycle({ prices, profiles }, models) {
  /** @type {Record<string, StageCost>} */
  const stages = {};
  for (const stage of STAGES) {
    const model = models[stage];
    if (typeof model !== 'string' || model === '') {
      throw new Error(`конфигурация: не задана модель стадии ${stage}`);
    }
    stages[stage] = priceStage({ prices }, model, profiles[stage]);
  }

  const total = STAGES.reduce((sum, stage) => sum + stages[stage].total, 0);
  return { stages, total };
}

/**
 * Округление до копеек для показа. `-0` приводится к `0`: в таблице он читается как ошибка.
 * @param {number} value
 * @returns {number}
 */
export function roundRub(value) {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Число для таблицы: всегда два знака после запятой, без разделителей разрядов.
 * @param {number} value
 * @returns {string}
 */
export function formatRub(value) {
  return roundRub(value).toFixed(2);
}

/**
 * Знаковая дельта для таблицы: сравнение конфигураций читается глазами.
 * @param {number} value
 * @returns {string}
 */
export function formatDelta(value) {
  const rounded = roundRub(value);
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(2)}`;
}
