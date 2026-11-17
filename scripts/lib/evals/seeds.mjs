/**
 * Сиды `evals/orchestrator/seeds/*.json` — эталонные диффы для проверки этапов
 * (docs/orchestrator.md §15, `docs/evals.md`).
 *
 * Сид описывает не патч в формате `git diff`, а два состояния дерева — «до» и «после».
 * Патч собирает `evals-pack.mjs` через настоящий git: так `diff.patch` всегда совпадает
 * с деревом, в котором работают агенты, и не расходится с ним после правки фикстуры.
 *
 * Схема проверяется вручную, без зависимостей (как `lib/cycle/validate.mjs`, D6):
 * `{ ok, errors[] }` и никаких исключений на битом документе — вызывающий решает,
 * печатать ошибку или падать.
 *
 * Shebang не нужен: модуль подключается из CLI-скриптов `evals-*.mjs`.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { readJson } from '../cycle/io.mjs';

/** Идентификатор сида: `E` + номер, как в таблице §15. */
const SEED_ID_PATTERN = /^E[1-9]\d*$/u;

/** Ожидаемые виды сида: дефект (этап должен его найти) и чистый дифф (не должен). */
const KINDS = Object.freeze(['clean', 'defect']);

/** Серьёзность, при которой дефект считается найденным: замечание и блокер. */
export const HIT_SEVERITIES = Object.freeze(['BLOCKER', 'MAJOR']);

/** Все серьёзности, допустимые в `expect.severities`: у оценщика нет FOLLOW-UP, у ревью есть. */
export const ALL_SEVERITIES = Object.freeze(['BLOCKER', 'MAJOR', 'MINOR', 'FOLLOW-UP']);

/**
 * @typedef {object} SeedExpectation
 * @property {'clean'|'defect'} kind вид сида
 * @property {'BLOCKER'|'MAJOR'} [severity] минимальная серьёзность находки
 * @property {string[]} [severities] точный набор допустимых серьёзностей (для сидов вроде E1,
 *   где ожидается MAJOR или FOLLOW-UP, а не «не ниже BLOCKER»)
 * @property {string} [file] файл дефекта относительно корня дерева
 * @property {number} [line] строка дефекта в файле «после»
 */

/**
 * @typedef {object} Seed
 * @property {string} id
 * @property {string} title
 * @property {string} why
 * @property {SeedExpectation} expect
 * @property {{ title: string, body: string }} issue
 * @property {string[]} criteria
 * @property {Record<string, string>} base файлы «до»
 * @property {Record<string, string>} after файлы «после»
 * @property {string[]} deleted удалённые файлы
 */

/** Плоский объект: массивы и `null` объектами не считаются. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Непустая строка.
 * @param {unknown} value
 * @param {string} label
 * @param {string[]} errors
 * @returns {boolean}
 */
function reqText(value, label, errors) {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${label}: ожидается непустая строка`);
    return false;
  }
  return true;
}

/**
 * Путь в дереве: относительный, без `..` и без ведущего слэша. Абсолютный путь или
 * выход вверх означали бы запись вне каталога прогона, поэтому это ошибка схемы,
 * а не проверка при записи.
 * @param {unknown} value
 * @param {string} label
 * @param {string[]} errors
 * @returns {boolean}
 */
function reqPath(value, label, errors) {
  if (!reqText(value, label, errors)) return false;
  const path = /** @type {string} */ (value);
  if (path.startsWith('/') || path.includes('\\')) {
    errors.push(`${label}: ожидается относительный путь с /`);
    return false;
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    errors.push(`${label}: недопустимый сегмент пути в ${path}`);
    return false;
  }
  return true;
}

/**
 * Карта файлов `путь → содержимое`. Пустая карта допустима для `base`: сид может
 * целиком состоять из новых файлов.
 * @param {unknown} value
 * @param {string} label
 * @param {string[]} errors
 * @returns {Record<string, string>}
 */
function reqFileMap(value, label, errors) {
  if (!isRecord(value)) {
    errors.push(`${label}: ожидается объект "путь → содержимое"`);
    return {};
  }
  /** @type {Record<string, string>} */
  const files = {};
  for (const [path, text] of Object.entries(value)) {
    const pathOk = reqPath(path, `${label}["${path}"]`, errors);
    const textOk = reqText(text, `${label}["${path}"]`, errors);
    if (pathOk && textOk) files[path] = /** @type {string} */ (text);
  }
  return files;
}

/**
 * Проверка одного сида. Ошибки собираются все: править сид удобнее за один проход.
 * @param {unknown} doc
 * @returns {{ ok: boolean, errors: string[], seed: Seed|null }}
 */
export function readSeed(doc) {
  /** @type {string[]} */
  const errors = [];
  if (!isRecord(doc)) {
    return { ok: false, errors: ['сид: ожидается объект'], seed: null };
  }

  if (!reqText(doc.id, 'id', errors) || !SEED_ID_PATTERN.test(/** @type {string} */ (doc.id))) {
    if (typeof doc.id === 'string' && doc.id.trim() !== '') {
      errors.push('id: ожидается E<номер>, например E5');
    }
  }
  reqText(doc.title, 'title', errors);
  reqText(doc.why, 'why', errors);

  /** @type {SeedExpectation} */
  let expect = { kind: 'clean' };
  const rawExpect = doc.expect;
  if (!isRecord(rawExpect)) {
    errors.push('expect: ожидается объект');
  } else if (!KINDS.includes(/** @type {any} */ (rawExpect.kind))) {
    errors.push(`expect.kind: ожидается ${KINDS.join('|')}`);
  } else if (rawExpect.kind === 'defect') {
    /** @type {SeedExpectation} */
    const parsed = { kind: 'defect' };
    if (rawExpect.severities !== undefined) {
      if (!Array.isArray(rawExpect.severities) || rawExpect.severities.length === 0) {
        errors.push('expect.severities: ожидается непустой массив серьёзностей');
      } else {
        const unknown = rawExpect.severities.filter(
          (item) => !ALL_SEVERITIES.includes(/** @type {any} */ (item)),
        );
        if (unknown.length > 0) {
          errors.push(`expect.severities: неизвестные значения ${unknown.join(', ')}`);
        }
        if (rawExpect.severity !== undefined) {
          errors.push('expect: severity и severities одновременно не задаются');
        }
        parsed.severities = rawExpect.severities.map(String);
      }
    } else if (!HIT_SEVERITIES.includes(/** @type {any} */ (rawExpect.severity))) {
      errors.push(`expect.severity: ожидается ${HIT_SEVERITIES.join('|')}`);
    } else {
      parsed.severity = /** @type {'BLOCKER'|'MAJOR'} */ (rawExpect.severity);
    }
    if (reqPath(rawExpect.file, 'expect.file', errors)) {
      parsed.file = /** @type {string} */ (rawExpect.file);
    }
    if (rawExpect.line !== undefined && rawExpect.line !== null) {
      if (!Number.isInteger(rawExpect.line) || /** @type {number} */ (rawExpect.line) < 1) {
        errors.push('expect.line: ожидается целое ≥ 1');
      } else {
        parsed.line = /** @type {number} */ (rawExpect.line);
      }
    }
    expect = parsed;
  } else {
    expect = { kind: 'clean' };
  }

  const issue = isRecord(doc.issue) ? doc.issue : {};
  if (!isRecord(doc.issue)) errors.push('issue: ожидается объект');
  reqText(issue.title, 'issue.title', errors);
  reqText(issue.body, 'issue.body', errors);

  const rawCriteria = Array.isArray(doc.criteria) ? doc.criteria : [];
  if (rawCriteria.length === 0) errors.push('criteria: нужен хотя бы один критерий');
  const criteria = [];
  rawCriteria.forEach((item, index) => {
    if (reqText(item, `criteria[${index}]`, errors)) criteria.push(/** @type {string} */ (item));
  });

  const base = reqFileMap(doc.base ?? {}, 'base', errors);
  const after = reqFileMap(doc.after, 'after', errors);

  /** @type {string[]} */
  const deleted = [];
  if (doc.deleted !== undefined) {
    if (!Array.isArray(doc.deleted)) {
      errors.push('deleted: ожидается массив путей');
    } else {
      doc.deleted.forEach((path, index) => {
        if (reqPath(path, `deleted[${index}]`, errors)) deleted.push(/** @type {string} */ (path));
      });
    }
  }

  if (Object.keys(after).length === 0 && deleted.length === 0) {
    errors.push('after: пустой дифф — сиду нечего проверять');
  }

  if (errors.length > 0) return { ok: false, errors, seed: null };

  return {
    ok: true,
    errors,
    seed: {
      id: /** @type {string} */ (doc.id),
      title: /** @type {string} */ (doc.title),
      why: /** @type {string} */ (doc.why),
      expect,
      issue: {
        title: /** @type {string} */ (issue.title),
        body: /** @type {string} */ (issue.body),
      },
      criteria,
      base,
      after,
      deleted,
    },
  };
}

/**
 * Все сиды каталога, упорядоченные по номеру. Имя файла обязано совпадать с `id`:
 * иначе ссылка на сид в отчёте перестаёт находить файл.
 * @param {string} dir каталог сидов
 * @returns {Seed[]}
 */
export function loadSeeds(dir) {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();

  /** @type {Seed[]} */
  const seeds = [];
  /** @type {Map<string, string>} */
  const seen = new Map();

  for (const name of names) {
    const label = `seeds/${name}`;
    const result = readSeed(readJson(join(dir, name)));
    if (!result.ok || result.seed === null) {
      throw new Error(`${label}: схема нарушена:\n${result.errors.join('\n')}`);
    }
    const seed = result.seed;
    if (`${seed.id}.json` !== name) {
      throw new Error(`${label}: id ${seed.id} не совпадает с именем файла`);
    }
    const previous = seen.get(seed.id);
    if (previous !== undefined) {
      throw new Error(`${label}: сид ${seed.id} уже объявлен в ${previous}`);
    }
    seen.set(seed.id, label);
    seeds.push(seed);
  }

  if (seeds.length === 0) throw new Error(`${dir}: сидов нет`);
  return seeds.sort((left, right) => seedOrder(left.id) - seedOrder(right.id));
}

/**
 * Числовой порядок сидов: `E2` идёт раньше `E10`, строковое сравнение дало бы наоборот.
 * @param {string} id
 * @returns {number}
 */
export function seedOrder(id) {
  return Number(id.slice(1));
}

/**
 * Текст `evidence/issue.md`: заголовок и тело issue дословно, как их видит агент.
 * @param {Seed} seed
 * @returns {string}
 */
export function seedIssueMarkdown(seed) {
  return `# ${seed.issue.title}\n\n${seed.issue.body}\n`;
}

/**
 * Текст `evidence/criteria.md`: единственный источник критериев приёмки (§7).
 * @param {Seed} seed
 * @returns {string}
 */
export function seedCriteriaMarkdown(seed) {
  const lines = seed.criteria.map((criterion, index) => `- C${index + 1} ${criterion}`);
  return `# Критерии приёмки\n\n${lines.join('\n')}\n`;
}
