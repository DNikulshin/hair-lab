/**
 * Лимиты цикла: источники, приоритет и валидация (issue #235).
 *
 * Зачем: пороги `LIMITS` были заморожены в коде ядра, поэтому поднять бюджет цикла можно было
 * только правкой `config.mjs`. Порог живёт в проекте, а не в ядре, поэтому значения читаются из
 * `.pi/harness.config.json` (раздел `limits`). Схема файла согласована с ядром `dev-harness`:
 * тот же файл, раздел `limits`; остальные разделы (`gates`, `paths`, `gateTimeouts`) здесь не читаются.
 *
 * Приоритет по каждому ключу: CLI-флаг → переменная окружения → файл проекта → дефолт в `config.mjs`.
 * Невалидное значение — ошибка (`UsageError`, код 2 у скриптов), а не молчаливый откат к дефолту:
 * иначе поднятый лимит «не применяется» без следа, и цикл эскалируется по прежнему порогу.
 *
 * Наблюдаемость: `resolveLimits` возвращает не только значения, но и источник каждого
 * (`cli`/`env`/`config`/`default`) — он попадает в `decision.<n>.json` и `metrics.json`,
 * чтобы по артефактам было видно, с каким лимитом считали.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LIMITS } from './config.mjs';

/** Файл проектного конфига harness: тот же, что у ядра `dev-harness` (#235, этап B). */
export const HARNESS_CONFIG_FILE = join('.pi', 'harness.config.json');

/** Ошибка конфигурации: скрипты цикла превращают её в код 2 (ошибка использования). */
export class LimitsConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LimitsConfigError';
  }
}

/**
 * Ключи лимитов и правила проверки. `integer` — целое (дроби не допускаются, кроме бюджета),
 * `min`/`max` — допустимый диапазон. Бюджет — рубли, допускает дробное значение.
 * @type {Readonly<Record<string, { integer: boolean, min: number, max: number }>>}
 */
export const LIMIT_RULES = Object.freeze({
  maxCycleCostRub: { integer: false, min: 1, max: 10_000 },
  defaultMaxIterations: { integer: true, min: 1, max: 10 },
  maxDiffLines: { integer: true, min: 50, max: 100_000 },
  maxDiffBytes: { integer: true, min: 1_024, max: 10 * 1024 * 1024 },
  logMaxBytes: { integer: true, min: 1_024, max: 100 * 1024 * 1024 },
  evidenceTailLines: { integer: true, min: 1, max: 10_000 },
});

/** Ключи лимитов в нормативном порядке. */
export const LIMIT_KEYS = Object.freeze(Object.keys(LIMIT_RULES));

/**
 * CLI-флаги, переопределяющие лимиты. Остальные ключи переопределяются только окружением:
 * флагов на каждый порог не заводим, чтобы интерфейс скриптов не разрастался.
 * @type {Readonly<Record<string, string>>}
 */
export const LIMIT_FLAGS = Object.freeze({
  maxCycleCostRub: '--max-cost-rub',
  defaultMaxIterations: '--max-iterations',
});

/**
 * Имя переменной окружения для ключа: `HARNESS_LIMIT_<SNAKE_UPPER>`.
 * @param {string} key
 * @returns {string}
 */
export function envNameFor(key) {
  return `HARNESS_LIMIT_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
}

/**
 * Проверяет одно значение лимита.
 * @param {string} key
 * @param {unknown} value
 * @param {string} source человекочитаемый источник (для текста ошибки)
 * @returns {number}
 */
export function checkLimitValue(key, value, source) {
  const rule = LIMIT_RULES[key];
  if (rule === undefined) throw new LimitsConfigError(`limits: неизвестный лимит «${key}»`);

  const numeric = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
    throw new LimitsConfigError(
      `limits.${key}: ожидается число, получено ${JSON.stringify(value)} (${source})`,
    );
  }
  if (rule.integer && !Number.isInteger(numeric)) {
    throw new LimitsConfigError(
      `limits.${key}: ожидается целое число, получено ${numeric} (${source})`,
    );
  }
  if (numeric < rule.min || numeric > rule.max) {
    throw new LimitsConfigError(
      `limits.${key}: ${numeric} вне диапазона ${rule.min}…${rule.max} (${source})`,
    );
  }
  return numeric;
}

/**
 * Читает раздел `limits` проектного конфига. Нет файла или раздела — пустой объект
 * (поведение по умолчанию не меняется). Битый JSON и неизвестные ключи — ошибка:
 * опечатка в имени лимита иначе молча оставила бы дефолт.
 * @param {string} root корень репозитория
 * @param {{ readFile?: (path: string) => string }} [options]
 * @returns {{ limits: Record<string, unknown>, path: string }}
 */
export function readLimitsFile(root, { readFile = (path) => readFileSync(path, 'utf8') } = {}) {
  const path = join(root, HARNESS_CONFIG_FILE);
  let text;
  try {
    text = readFile(path);
  } catch {
    return { limits: {}, path };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new LimitsConfigError(
      `${HARNESS_CONFIG_FILE}: некорректный JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LimitsConfigError(`${HARNESS_CONFIG_FILE}: ожидается объект`);
  }

  const limits = parsed.limits;
  if (limits === undefined) return { limits: {}, path };
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
    throw new LimitsConfigError(`${HARNESS_CONFIG_FILE}: раздел limits должен быть объектом`);
  }
  for (const key of Object.keys(limits)) {
    if (!(key in LIMIT_RULES)) {
      throw new LimitsConfigError(
        `${HARNESS_CONFIG_FILE}: неизвестный лимит «${key}» (допустимы: ${LIMIT_KEYS.join(', ')})`,
      );
    }
  }
  return { limits, path };
}

/**
 * Итоговые лимиты с приоритетом CLI → env → конфиг → дефолт.
 * @param {{
 *   root: string,
 *   cli?: Record<string, unknown>,
 *   env?: NodeJS.ProcessEnv,
 *   defaults?: Record<string, number>,
 *   readFile?: (path: string) => string,
 * }} options
 * @returns {{ values: Record<string, number>, sources: Record<string, 'cli'|'env'|'config'|'default'> }}
 */
export function resolveLimits({ root, cli = {}, env = process.env, defaults = LIMITS, readFile }) {
  const fromFile = readLimitsFile(root, readFile === undefined ? {} : { readFile });

  /** @type {Record<string, number>} */
  const values = {};
  /** @type {Record<string, 'cli'|'env'|'config'|'default'>} */
  const sources = {};

  for (const key of LIMIT_KEYS) {
    const cliValue = cli[key];
    if (cliValue !== undefined && cliValue !== null) {
      values[key] = checkLimitValue(key, cliValue, `${LIMIT_FLAGS[key] ?? '--' + key}`);
      sources[key] = 'cli';
      continue;
    }

    const envName = envNameFor(key);
    const envValue = env[envName];
    if (typeof envValue === 'string' && envValue.trim() !== '') {
      values[key] = checkLimitValue(key, envValue, envName);
      sources[key] = 'env';
      continue;
    }

    const fileValue = fromFile.limits[key];
    if (fileValue !== undefined) {
      values[key] = checkLimitValue(key, fileValue, HARNESS_CONFIG_FILE);
      sources[key] = 'config';
      continue;
    }

    values[key] = defaults[key];
    sources[key] = 'default';
  }

  return { values, sources };
}

/**
 * Компактная запись применённых лимитов для артефактов (`decision.<n>.json`, `metrics.json`).
 * @param {{ values: Record<string, number>, sources: Record<string, string> }} resolved
 * @returns {Record<string, { value: number, source: string }>}
 */
export function describedLimits({ values, sources }) {
  /** @type {Record<string, { value: number, source: string }>} */
  const described = {};
  for (const key of LIMIT_KEYS) described[key] = { value: values[key], source: sources[key] };
  return described;
}
