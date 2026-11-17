/**
 * Стоимость цикла по `usage.json` и снапшоту цен `evals/prices.json`.
 *
 * Модуль общий для двух скриптов: `cycle-metrics.mjs` пишет `cost_rub` в `metrics.json`
 * (постфактум), а `cycle-decide.mjs` проверяет бюджетный порог (§5.6, правило 7) на момент
 * решения — там `metrics.json` ещё не существует. Логика расчёта одна, иначе порог и метрика
 * считались бы по-разному. Чистые функции (`normalizeUsage`, `priceKeyFor`, `priceUsage`)
 * тестируются без запуска процессов; чтение файлов — в `readUsage` / `readPriceSnapshot`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { priceStage, readPrices } from '../evals/cost.mjs';
import { readJson } from './io.mjs';
import { FIXED_NAMES } from './paths.mjs';

/** Этапы, на которых вызывается модель: только у них бывает расход токенов. */
export const MODEL_STAGES = Object.freeze(['plan', 'code', 'review', 'evaluate']);

/** Причины ошибок чтения по `error.code`: системный текст Node содержит абсолютный путь. */
const READ_ERROR_REASONS = Object.freeze({
  ENOENT: 'файл не найден',
  EACCES: 'нет доступа на чтение',
  EPERM: 'нет доступа на чтение',
  EISDIR: 'ожидался файл, а не каталог',
});

/**
 * Плоский объект: массивы и `null` объектами не считаются.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Человекочитаемая причина ошибки чтения.
 * @param {unknown} error
 * @returns {string}
 */
export function describeReadError(error) {
  const code = /** @type {{ code?: unknown } | null | undefined} */ (error)?.code;
  if (typeof code !== 'string' || code === '') return 'ошибка чтения';
  return Object.hasOwn(READ_ERROR_REASONS, code) ? READ_ERROR_REASONS[code] : code;
}

/**
 * Причина ошибки разбора JSON без пути и без фрагмента текста: сообщение парсера
 * содержит начало файла, а в нём может оказаться путь.
 * @param {unknown} error
 * @returns {string}
 */
export function describeJsonError(error) {
  if (!(error instanceof Error)) return 'ошибка разбора JSON';
  const reason = error.message
    .split(/\r?\n/u)[0]
    .replace(/,\s*".*$/u, '')
    .replace(/ in JSON at position.*$/u, '')
    .trim();
  return reason === '' ? 'ошибка разбора JSON' : reason;
}

/**
 * Причина отказа чтения артефакта: системная ошибка файла или ошибка разбора JSON.
 * @param {unknown} error
 * @returns {string}
 */
function readFailureReason(error) {
  const code = /** @type {{ code?: unknown } | undefined} */ (error)?.code;
  return typeof code === 'string' ? describeReadError(error) : describeJsonError(error);
}

/**
 * Токены из `usage.json` в вид `metrics.json`: целые числа, ключи стадий в порядке
 * автомата. Лишние ключи — ошибка данных: неизвестный этап означал бы, что расход
 * посчитан не по тому словарю, и молча потерять его нельзя.
 * @param {unknown} usage содержимое `usage.json`
 * @returns {Record<string, { runs: number, input: number, cache_read: number, cache_write: number, output: number, reasoning: number }>}
 */
export function normalizeUsage(usage) {
  if (!isRecord(usage)) throw new Error('usage.json: ожидается объект этапов');

  /** @type {Record<string, any>} */
  const tokens = {};
  for (const [stage, value] of Object.entries(usage)) {
    if (!MODEL_STAGES.includes(stage)) {
      throw new Error(`usage.json: неизвестный этап ${stage}`);
    }
    if (!isRecord(value)) throw new Error(`usage.json.${stage}: ожидается объект`);
    /** @type {Record<string, number>} */
    const entry = {};
    for (const field of ['runs', 'input', 'cache_read', 'cache_write', 'output', 'reasoning']) {
      const number = value[field] ?? 0;
      if (!Number.isInteger(number) || number < 0) {
        throw new Error(`usage.json.${stage}.${field}: ожидается целое ≥ 0`);
      }
      entry[field] = number;
    }
    tokens[stage] = entry;
  }

  return tokens;
}

/**
 * Ключ модели в снапшоте цен.
 *
 * `state.models` хранит идентификатор с префиксом провайдера (`polza-ai/z-ai/glm-5.3` —
 * этого требует H4), а `evals/prices.json` — без него. Точное совпадение проверяется
 * первым, чтобы не зависеть от формы записи; затем пробуется вариант без первого сегмента.
 * `null` — модели нет в снапшоте, считать не по чему.
 * @param {string} model как записано в `state.models`
 * @param {Record<string, unknown>} prices снапшот цен
 * @returns {string|null}
 */
export function priceKeyFor(model, prices) {
  if (typeof model !== 'string' || model === '') return null;
  if (Object.hasOwn(prices, model)) return model;

  const slash = model.indexOf('/');
  if (slash > 0) {
    const withoutProvider = model.slice(slash + 1);
    if (Object.hasOwn(prices, withoutProvider)) return withoutProvider;
  }

  return null;
}

/**
 * Стоимость расхода по ценам и моделям этапов.
 * @param {Record<string, Record<string, number>>} tokens нормализованный расход
 * @param {Record<string, unknown>} models `state.models`
 * @param {Record<string, import('../evals/cost.mjs').ModelPrice>} prices снапшот цен
 * @returns {number|null} рубли с копейками или `null`, если считать не по чему
 */
export function priceUsage(tokens, models, prices) {
  if (!isRecord(tokens) || !isRecord(models) || !isRecord(prices)) return null;
  const stages = Object.keys(tokens);
  if (stages.length === 0) return null;

  let total = 0;
  for (const stage of stages) {
    const key = priceKeyFor(models[stage], prices);
    if (key === null) return null;

    const entry = tokens[stage];
    const priced = priceStage({ prices }, key, {
      calls_per_run: 0,
      input: entry.input,
      cache_read: entry.cache_read,
      output: entry.output,
      reasoning: entry.reasoning,
    });
    total += priced.total;
  }

  return Math.round(total * 100) / 100;
}

/**
 * Необязательный `usage.json` каталога цикла: файла нет — замера нет (`null`),
 * битый файл — отказ: испорченный расход исказил бы стоимость молча.
 * @param {string} dir каталог цикла
 * @returns {Record<string, any>|null}
 */
export function readUsage(dir) {
  const file = join(dir, FIXED_NAMES.usage);
  if (!existsSync(file)) return null;
  try {
    return /** @type {Record<string, any>} */ (readJson(file));
  } catch (error) {
    throw new Error(`${FIXED_NAMES.usage}: не читается (${readFailureReason(error)})`, {
      cause: error,
    });
  }
}

/**
 * Снапшот цен из репозитория. Отсутствие файла — не ошибка: цикл мог пройти до
 * появления снапшота, и тогда стоимость остаётся `null`, а токены заполняются.
 * Битый снапшот — отказ: цены влияют на бюджетные пороги, тихо игнорировать их нельзя.
 * @param {string} root корень репозитория
 * @returns {Record<string, import('../evals/cost.mjs').ModelPrice>|null}
 */
export function readPriceSnapshot(root) {
  const file = join(root, 'evals', 'prices.json');
  if (!existsSync(file)) return null;

  /** @type {unknown} */
  let doc;
  try {
    doc = readJson(file);
  } catch (error) {
    throw new Error(`evals/prices.json: не читается (${readFailureReason(error)})`, {
      cause: error,
    });
  }

  return readPrices(doc).models;
}

/**
 * Стоимость цикла по накопленному `usage.json` — вход бюджетного порога (§5.6, правило 7).
 * `null` означает «замера нет»: нет `usage.json`, пустой расход или модели/цены неизвестны.
 * Ноль вместо `null` был бы враньём — бюджет проверялся бы по несуществующим данным.
 * @param {{ dir: string, models: unknown, prices: Record<string, unknown>|null }} options
 * @returns {number|null} рубли с копейками или `null`
 */
export function cycleCostRub({ dir, models, prices }) {
  const usage = readUsage(dir);
  if (usage === null || prices === null) return null;
  return priceUsage(normalizeUsage(usage), /** @type {Record<string, unknown>} */ (models), prices);
}
