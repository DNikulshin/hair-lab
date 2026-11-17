/**
 * Валидаторы схем артефактов цикла (docs/orchestrator-core.md, Приложение A).
 *
 * Ручной код без Zod и новых зависимостей (D6). Сигнатура каждого валидатора —
 * `(doc) → { ok, errors[] }`: лишние поля игнорируются, отсутствующие обязательные
 * считаются ошибкой. Проверяется только структура: разрешение ссылок — `refs.mjs`,
 * маскирование — `redact.mjs`.
 * Общие хелперы: `req()` (обязательное поле), `int()` (целое в границах),
 * `oneOf()` (перечисление; имя `enum` в ESM недоступно — зарезервированное слово).
 * Shebang не нужен: модуль подключается из CLI-скриптов `cycle-*.mjs`.
 */

/** @typedef {{ ok: boolean, errors: string[] }} ValidationResult */

/** Этапы автомата §5.3. */
const STAGES = Object.freeze([
  'INIT',
  'PLAN',
  'CODE',
  'GATES',
  'QA_WEB',
  'REVIEW',
  'EVALUATE',
  'DECIDE',
  'REWORK',
  'ACQUIRE_EVIDENCE',
  'PR',
  'DONE',
  'ESCALATED',
]);

/** Статус этапа: пишется `cycle-state` и в `state.json`, и в `history[].status`. */
const STAGE_STATUSES = Object.freeze(['pending', 'running', 'done', 'error']);

/** Откуда взяты критерии приёмки (§5.3: `criteria` или явное одобрение владельца). */
const CRITERIA_SOURCES = Object.freeze(['issue', 'plan_owner_approved']);

/** Серьёзность замечания ревью (Приложение A, общая часть). */
const SEVERITIES = Object.freeze(['BLOCKER', 'MAJOR', 'MINOR', 'FOLLOW-UP']);

/** Серьёзность дефекта независимой оценки: `FOLLOW-UP` у оценщика не бывает. */
const DEFECT_SEVERITIES = Object.freeze(['BLOCKER', 'MAJOR', 'MINOR']);

/** Этапы, на которых вызывается модель: только у них есть расход токенов (§5.8). */
const MODEL_STAGES = Object.freeze(['plan', 'code', 'review', 'evaluate']);

/** Поля сумм расхода одного этапа в `metrics.tokens`. */
const MODEL_USAGE_FIELDS = Object.freeze([
  'runs',
  'input',
  'cache_read',
  'cache_write',
  'output',
  'reasoning',
]);

const GATE_STATUSES = Object.freeze(['pass', 'fail', 'skipped', 'not_run']);

/** Причины гейтов, не зависящие от другого гейта; `blocked_by:<id>` проверяется отдельно. */
const GATE_REASONS = Object.freeze(['not_applicable', 'no_database', 'timeout', 'tool_missing']);

const REVIEW_VERDICTS = Object.freeze(['merge-ready', 'needs-changes']);

const EVALUATION_VERDICTS = Object.freeze([
  'ACCEPT',
  'ACCEPT_WITH_FOLLOWUPS',
  'REWORK',
  'INSUFFICIENT_EVIDENCE',
]);

const CRITERION_STATUSES = Object.freeze(['met', 'partial', 'unmet', 'unverified']);

/** Оценки независимого оценщика: каждая 0–3 или `null` (Приложение A). */
const EVALUATION_SCORES = Object.freeze([
  'coverage',
  'correctness',
  'tests',
  'data',
  'pii_security',
  'architecture',
  'scope',
  'docs',
  'evidence',
]);

const QA_STATUSES = Object.freeze(['done', 'not_run']);

/** Действия `decision.<n>.json` (§5.6). */
const DECISION_ACTIONS = Object.freeze([
  'REWORK',
  'ACQUIRE_EVIDENCE',
  'RETRY_STAGE',
  'PROCEED',
  'PROCEED_WITH_UNVERIFIED',
  'ESCALATE',
]);

/** Причины эскалации, словарь D7. */
const ESCALATION_REASONS = Object.freeze([
  'criteria_missing',
  'plan_ambiguous',
  'agent_output_invalid',
  'iteration_limit',
  'budget',
  'scope_expansion_required',
  'diff_too_large',
  'internal_error',
]);

/** Этапы, которые можно повторить через `RETRY_STAGE` (§5.6, правило 1). */
const RETRY_STAGES = Object.freeze(['REVIEW', 'EVALUATE']);

/**
 * Допуск сравнения итоговых длительностей с суммой слагаемых. Писатель округляет
 * каждое слагаемое до 3 знаков и складывает уже округлённые значения, поэтому
 * точного совпадения ждать нельзя — только совпадения в пределах хвоста плавающей точки.
 */
const DURATION_TOLERANCE = 1e-6;

const SLUG_PATTERN = /^[a-z0-9-]{1,60}$/;
const SHA40_PATTERN = /^[0-9a-f]{40}$/;
/**
 * ISO-8601 со временем и зоной: `2026-11-16T09:00:00Z` или `+03:00`. Группы нужны для
 * календарной проверки (`isCalendarValid`): шаблон сам по себе пропускал бы `2026-02-30`.
 */
const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
/** Число дней в месяце без февраля; февраль зависит от года. */
const MONTH_DAYS = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
const CRITERION_ID_PATTERN = /^C[1-9]\d*$/;
/** Шаги QA получают `id` вида `s1`, `s2` (D8) — на них ссылаются `qa:<id>`. */
const QA_STEP_ID_PATTERN = /^s[1-9]\d*$/;
const GATE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
/** Причина зависимого гейта: `blocked_by:<id>` (§5.5). */
const BLOCKED_BY_PATTERN = /^blocked_by:[a-z][a-z0-9_]*$/;

/**
 * Плоский объект: массивы и `null` объектами не считаются.
 * @param {unknown} value
 * @returns {boolean}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Високосный год по григорианскому календарю.
 * @param {number} year
 * @returns {boolean}
 */
function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Календарная валидность значения, уже прошедшего `ISO_PATTERN`: месяц 1–12, день не
 * больше числа дней в месяце, часы 0–23, минуты и секунды 0–59, смещение зоны правдоподобно.
 * @param {string} value
 * @returns {boolean}
 */
function isCalendarValid(value) {
  const match = ISO_PATTERN.exec(value);
  if (match === null) return false;

  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match
    .slice(1)
    .map((part) => (part === undefined ? undefined : Number(part)));

  if (month < 1 || month > 12) return false;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1];
  if (day < 1 || day > maxDay) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  // `Z` в группах смещения не попал — это допустимая зона.
  if (offsetHour !== undefined && (offsetHour > 23 || offsetMinute > 59)) return false;

  return true;
}

/**
 * Короткое представление значения для сообщения об ошибке.
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  }
  if (Array.isArray(value)) return 'массив';
  if (isRecord(value)) return 'объект';
  return String(value);
}

/**
 * Обязательное поле: отсутствие — ошибка, дальше тип проверяет вызывающий.
 * @param {unknown} parent объект (или что угодно — тогда поле считается отсутствующим)
 * @param {string} key имя поля
 * @param {string} path путь для сообщения, `<схема>.<поле>`
 * @param {string[]} errors накопитель ошибок
 * @returns {unknown} значение или `undefined`, если поле отсутствует (уже сообщено)
 */
function req(parent, key, path, errors) {
  if (isRecord(parent) && Object.hasOwn(parent, key) && parent[key] !== undefined) {
    return parent[key];
  }
  errors.push(`${path}: обязательное поле отсутствует`);
  return undefined;
}

/**
 * Целое число в границах. `undefined` не проверяется: об отсутствии уже сообщил `req`.
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 * @param {{ min?: number, max?: number }} [options]
 * @returns {boolean}
 */
function int(value, path, errors, { min, max } = {}) {
  if (value === undefined) return false;
  if (!Number.isInteger(value)) {
    errors.push(`${path}: ожидается целое число, получено ${describe(value)}`);
    return false;
  }
  if (min !== undefined && /** @type {number} */ (value) < min) {
    errors.push(`${path}: ожидается целое ≥ ${min}, получено ${value}`);
    return false;
  }
  if (max !== undefined && /** @type {number} */ (value) > max) {
    errors.push(`${path}: ожидается целое ≤ ${max}, получено ${value}`);
    return false;
  }
  return true;
}

/**
 * Число (не обязательно целое) с нижней границей; `undefined` не проверяется.
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 * @param {{ min?: number }} [options]
 * @returns {boolean}
 */
function num(value, path, errors, { min } = {}) {
  if (value === undefined) return false;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    errors.push(`${path}: ожидается число, получено ${describe(value)}`);
    return false;
  }
  if (min !== undefined && value < min) {
    errors.push(`${path}: ожидается число ≥ ${min}, получено ${value}`);
    return false;
  }
  return true;
}

/**
 * Строка, при необходимости — соответствующая шаблону.
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 * @param {{ pattern?: RegExp, allowEmpty?: boolean }} [options]
 * @returns {boolean}
 */
function str(value, path, errors, { pattern, allowEmpty = true } = {}) {
  if (value === undefined) return false;
  if (typeof value !== 'string') {
    errors.push(`${path}: ожидается строка, получено ${describe(value)}`);
    return false;
  }
  if (!allowEmpty && value.trim() === '') {
    errors.push(`${path}: пустая строка недопустима`);
    return false;
  }
  if (pattern && !pattern.test(value)) {
    errors.push(`${path}: значение не соответствует шаблону ${pattern}: ${describe(value)}`);
    return false;
  }
  return true;
}

/**
 * Строка с ISO-8601 временем: сначала форма (`ISO_PATTERN`), потом календарь.
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 * @returns {boolean}
 */
function isoStr(value, path, errors) {
  if (!str(value, path, errors, { pattern: ISO_PATTERN })) return false;
  if (!isCalendarValid(/** @type {string} */ (value))) {
    errors.push(`${path}: невозможные дата или время ISO-8601: ${describe(value)}`);
    return false;
  }
  return true;
}

/**
 * Перечисление: значение должно быть одной из строк списка.
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 * @param {readonly string[]} allowed
 * @returns {boolean}
 */
function oneOf(value, path, errors, allowed) {
  if (value === undefined) return false;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    errors.push(`${path}: ожидается одно из ${allowed.join('|')}, получено ${describe(value)}`);
    return false;
  }
  return true;
}

/**
 * Булево значение.
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 * @returns {boolean}
 */
function bool(value, path, errors) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    errors.push(`${path}: ожидается boolean, получено ${describe(value)}`);
    return false;
  }
  return true;
}

/**
 * Массив: каждый элемент проверяется своей функцией.
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 * @param {(item: unknown, path: string, errors: string[]) => void} each
 * @returns {boolean}
 */
function list(value, path, errors, each) {
  if (value === undefined) return false;
  if (!Array.isArray(value)) {
    errors.push(`${path}: ожидается массив, получено ${describe(value)}`);
    return false;
  }
  value.forEach((item, index) => each(item, `${path}[${index}]`, errors));
  return true;
}

/**
 * Плоский объект: содержимое проверяет переданная функция.
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 * @param {(value: Record<string, unknown>, path: string, errors: string[]) => void} check
 * @returns {boolean}
 */
function record(value, path, errors, check) {
  if (value === undefined) return false;
  if (!isRecord(value)) {
    errors.push(`${path}: ожидается объект, получено ${describe(value)}`);
    return false;
  }
  check(/** @type {Record<string, unknown>} */ (value), path, errors);
  return true;
}

/** Обязательное поле + `int`. */
function reqInt(parent, key, prefix, errors, options) {
  const path = `${prefix}.${key}`;
  return int(req(parent, key, path, errors), path, errors, options);
}

/** Обязательное поле + `str`. */
function reqStr(parent, key, prefix, errors, options) {
  const path = `${prefix}.${key}`;
  return str(req(parent, key, path, errors), path, errors, options);
}

/** Обязательное поле + `isoStr`. */
function reqIso(parent, key, prefix, errors) {
  const path = `${prefix}.${key}`;
  return isoStr(req(parent, key, path, errors), path, errors);
}

/** Обязательное поле + `oneOf`. */
function reqOneOf(parent, key, prefix, errors, allowed) {
  const path = `${prefix}.${key}`;
  return oneOf(req(parent, key, path, errors), path, errors, allowed);
}

/** Обязательное поле + `bool`. */
function reqBool(parent, key, prefix, errors) {
  return bool(req(parent, key, `${prefix}.${key}`, errors), `${prefix}.${key}`, errors);
}

/** Обязательное поле + `list`. */
function reqList(parent, key, prefix, errors, each) {
  const path = `${prefix}.${key}`;
  return list(req(parent, key, path, errors), path, errors, each);
}

/** Обязательное поле + `record`. */
function reqRecord(parent, key, prefix, errors, check) {
  const path = `${prefix}.${key}`;
  return record(req(parent, key, path, errors), path, errors, check);
}

/**
 * Обязательное поле, допускающее `null`: тип проверяется только для непустого значения.
 * @param {unknown} parent
 * @param {string} key
 * @param {string} prefix
 * @param {string[]} errors
 * @param {(value: unknown, path: string, errors: string[]) => void} check
 * @returns {boolean}
 */
function reqNullable(parent, key, prefix, errors, check) {
  const path = `${prefix}.${key}`;
  const value = req(parent, key, path, errors);
  if (value === undefined || value === null) return value === null;
  check(value, path, errors);
  return true;
}

/** Элемент-список строк: непустая строка. */
function textItem(item, path, errors) {
  str(item, path, errors, { allowEmpty: false });
}

/**
 * Элемент сырых данных QA: форма не нормативна, поэтому допускаются строки и объекты.
 * @param {unknown} item
 * @param {string} path
 * @param {string[]} errors
 * @returns {void}
 */
function rawItem(item, path, errors) {
  if (isRecord(item)) return;
  str(item, path, errors);
}

/** Причина гейта: `null`, причина из списка §5.5 или `blocked_by:<id>`. */
function gateReason(value, path, errors) {
  if (value === null) return;
  const ok =
    typeof value === 'string' && (GATE_REASONS.includes(value) || BLOCKED_BY_PATTERN.test(value));
  if (ok) return;
  errors.push(
    `${path}: ожидается одна из причин ${[...GATE_REASONS, 'blocked_by:<id>'].join('|')}, получено ${describe(value)}`,
  );
}

/**
 * Поля эскалации, общие для `state.escalation` и `escalation.json`.
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} errors
 * @returns {void}
 */
function escalationFields(value, path, errors) {
  reqOneOf(value, 'reason', path, errors, ESCALATION_REASONS);
  reqNullable(value, 'detail', path, errors, (detail, detailPath, errs) => {
    str(detail, detailPath, errs);
  });
  reqBool(value, 'draft_pr_allowed', path, errors);
}

/**
 * Элемент `state.history[]`.
 * @param {unknown} item
 * @param {string} path
 * @param {string[]} errors
 * @returns {void}
 */
function validateHistoryEntry(item, path, errors) {
  if (!isRecord(item)) {
    errors.push(`${path}: ожидается объект, получено ${describe(item)}`);
    return;
  }
  reqOneOf(item, 'stage', path, errors, STAGES);
  reqInt(item, 'iteration', path, errors, { min: 1 });
  reqIso(item, 'started_at', path, errors);
  reqNullable(item, 'finished_at', path, errors, (value, valuePath, errs) => {
    isoStr(value, valuePath, errs);
  });
  reqOneOf(item, 'status', path, errors, STAGE_STATUSES);
}

/**
 * `state.json` (Приложение A). Счётчики `retries` — целые ≥ 0, `iteration` не больше
 * `max_iterations`, кроме случая явного одобрения владельца (`owner_approved`).
 * @param {unknown} doc
 * @returns {ValidationResult}
 */
export function validateState(doc) {
  const errors = [];
  if (!isRecord(doc)) {
    return { ok: false, errors: [`state: ожидается объект, получено ${describe(doc)}`] };
  }

  reqInt(doc, 'issue', 'state', errors, { min: 1 });
  reqStr(doc, 'slug', 'state', errors, { pattern: SLUG_PATTERN, allowEmpty: false });
  reqStr(doc, 'branch', 'state', errors, { allowEmpty: false });
  reqStr(doc, 'base_sha', 'state', errors, { pattern: SHA40_PATTERN });

  const iterationOk = reqInt(doc, 'iteration', 'state', errors, { min: 1 });
  const maxIterationsOk = reqInt(doc, 'max_iterations', 'state', errors, { min: 1 });
  reqBool(doc, 'owner_approved', 'state', errors);
  if (
    iterationOk &&
    maxIterationsOk &&
    /** @type {number} */ (doc.iteration) > /** @type {number} */ (doc.max_iterations) &&
    doc.owner_approved !== true
  ) {
    errors.push(
      `state.iteration: ${doc.iteration} > max_iterations ${doc.max_iterations} без owner_approved`,
    );
  }

  reqOneOf(doc, 'stage', 'state', errors, STAGES);
  reqOneOf(doc, 'stage_status', 'state', errors, STAGE_STATUSES);
  reqOneOf(doc, 'criteria_source', 'state', errors, CRITERIA_SOURCES);

  reqRecord(doc, 'retries', 'state', errors, (retries, path, errs) => {
    for (const key of ['REVIEW', 'EVALUATE', 'evidence'])
      reqInt(retries, key, path, errs, { min: 0 });
  });

  reqRecord(doc, 'models', 'state', errors, (models, path, errs) => {
    for (const [key, value] of Object.entries(models)) {
      str(value, `${path}.${key}`, errs, { allowEmpty: false });
    }
  });

  reqList(doc, 'history', 'state', errors, validateHistoryEntry);

  reqNullable(doc, 'escalation', 'state', errors, (value, path, errs) => {
    record(value, path, errs, escalationFields);
  });

  reqIso(doc, 'started_at', 'state', errors);
  reqIso(doc, 'updated_at', 'state', errors);

  return { ok: errors.length === 0, errors };
}

/**
 * Элемент `gates[]`: `cmd`, `exit`, `log`, `reason` могут быть `null`.
 * @param {unknown} item
 * @param {string} path
 * @param {string[]} errors
 * @returns {void}
 */
function validateGateEntry(item, path, errors) {
  if (!isRecord(item)) {
    errors.push(`${path}: ожидается объект, получено ${describe(item)}`);
    return;
  }
  reqStr(item, 'id', path, errors, { pattern: GATE_ID_PATTERN, allowEmpty: false });
  reqNullable(item, 'cmd', path, errors, (value, valuePath, errs) => {
    str(value, valuePath, errs, { allowEmpty: false });
  });
  reqBool(item, 'required', path, errors);
  reqOneOf(item, 'status', path, errors, GATE_STATUSES);
  reqNullable(item, 'exit', path, errors, (value, valuePath, errs) => {
    int(value, valuePath, errs, { min: 0 });
  });
  const durationPath = `${path}.duration_s`;
  num(req(item, 'duration_s', durationPath, errors), durationPath, errors, { min: 0 });
  reqNullable(item, 'log', path, errors, (value, valuePath, errs) => {
    str(value, valuePath, errs);
  });
  reqNullable(item, 'reason', path, errors, gateReason);
}

/**
 * `gates.<n>.json` (§5.5).
 * @param {unknown} doc
 * @returns {ValidationResult}
 */
export function validateGates(doc) {
  const errors = [];
  if (!isRecord(doc)) {
    return { ok: false, errors: [`gates: ожидается объект, получено ${describe(doc)}`] };
  }

  reqInt(doc, 'iteration', 'gates', errors, { min: 1 });
  reqStr(doc, 'base_sha', 'gates', errors, { pattern: SHA40_PATTERN });
  // `head` — sha или имя ссылки: формат не фиксируем, но пустым он быть не может.
  reqStr(doc, 'head', 'gates', errors, { allowEmpty: false });
  reqIso(doc, 'started_at', 'gates', errors);
  reqList(doc, 'gates', 'gates', errors, validateGateEntry);

  return { ok: errors.length === 0, errors };
}

/**
 * Элемент `findings[]` ревью. `file`, `line` и `repro` могут быть пустыми только
 * у `MINOR` и `FOLLOW-UP` (Приложение A): блокер без воспроизведения недопустим.
 * @param {unknown} item
 * @param {string} path
 * @param {string[]} errors
 * @returns {void}
 */
function validateFinding(item, path, errors) {
  if (!isRecord(item)) {
    errors.push(`${path}: ожидается объект, получено ${describe(item)}`);
    return;
  }
  reqStr(item, 'id', path, errors, { allowEmpty: false });
  const severityOk = reqOneOf(item, 'severity', path, errors, SEVERITIES);
  const strict = severityOk && (item.severity === 'BLOCKER' || item.severity === 'MAJOR');

  reqStr(item, 'file', path, errors, { allowEmpty: !strict });
  const linePath = `${path}.line`;
  const line = req(item, 'line', linePath, errors);
  if (strict) {
    int(line, linePath, errors, { min: 1 });
  } else if (line !== null && line !== '') {
    int(line, linePath, errors, { min: 1 });
  }
  reqStr(item, 'summary', path, errors, { allowEmpty: false });
  reqStr(item, 'repro', path, errors, { allowEmpty: !strict });
  reqBool(item, 'in_scope', path, errors);
  reqBool(item, 'preexisting', path, errors);
}

/**
 * Блок ```json из `review.<n>.md` (Приложение A).
 * @param {unknown} doc
 * @returns {ValidationResult}
 */
export function validateReview(doc) {
  const errors = [];
  if (!isRecord(doc)) {
    return { ok: false, errors: [`review: ожидается объект, получено ${describe(doc)}`] };
  }

  reqOneOf(doc, 'verdict', 'review', errors, REVIEW_VERDICTS);
  reqList(doc, 'findings', 'review', errors, validateFinding);

  return { ok: errors.length === 0, errors };
}

/**
 * Элемент `criteria[]` оценки: `id` — из `criteria.md` (`C1`, `C2`, …).
 * @param {unknown} item
 * @param {string} path
 * @param {string[]} errors
 * @returns {void}
 */
function validateCriterion(item, path, errors) {
  if (!isRecord(item)) {
    errors.push(`${path}: ожидается объект, получено ${describe(item)}`);
    return;
  }
  reqStr(item, 'id', path, errors, { pattern: CRITERION_ID_PATTERN });
  reqOneOf(item, 'status', path, errors, CRITERION_STATUSES);
  // Пустой `evidence` — не структурная ошибка: критерий просто останется без ссылок (§5.6).
  reqList(item, 'evidence', path, errors, textItem);
  reqStr(item, 'note', path, errors);
}

/**
 * Элемент `defects[]` оценки. Пустой `repro` допустим на уровне схемы: такой дефект
 * понижается на этапе решения (§5.6), а не считается невалидным выводом агента.
 * @param {unknown} item
 * @param {string} path
 * @param {string[]} errors
 * @returns {void}
 */
function validateDefect(item, path, errors) {
  if (!isRecord(item)) {
    errors.push(`${path}: ожидается объект, получено ${describe(item)}`);
    return;
  }
  reqStr(item, 'id', path, errors, { allowEmpty: false });
  reqOneOf(item, 'severity', path, errors, DEFECT_SEVERITIES);
  reqStr(item, 'claim', path, errors, { allowEmpty: false });
  reqList(item, 'evidence', path, errors, textItem);
  reqStr(item, 'repro', path, errors);
}

/**
 * Элемент `unverified[]` оценки.
 * @param {unknown} item
 * @param {string} path
 * @param {string[]} errors
 * @returns {void}
 */
function validateUnverified(item, path, errors) {
  if (!isRecord(item)) {
    errors.push(`${path}: ожидается объект, получено ${describe(item)}`);
    return;
  }
  reqStr(item, 'what', path, errors, { allowEmpty: false });
  reqStr(item, 'why', path, errors, { allowEmpty: false });
  reqStr(item, 'how_to_verify', path, errors, { allowEmpty: false });
}

/**
 * Блок ```json из `evaluation.<n>.md` (Приложение A).
 * @param {unknown} doc
 * @returns {ValidationResult}
 */
export function validateEvaluation(doc) {
  const errors = [];
  if (!isRecord(doc)) {
    return { ok: false, errors: [`evaluation: ожидается объект, получено ${describe(doc)}`] };
  }

  reqOneOf(doc, 'verdict', 'evaluation', errors, EVALUATION_VERDICTS);

  reqList(doc, 'criteria', 'evaluation', errors, validateCriterion);

  reqRecord(doc, 'scores', 'evaluation', errors, (scores, path, errs) => {
    for (const key of EVALUATION_SCORES) {
      const scorePath = `${path}.${key}`;
      const value = req(scores, key, scorePath, errs);
      if (value !== null) int(value, scorePath, errs, { min: 0, max: 3 });
    }
  });

  reqList(doc, 'defects', 'evaluation', errors, validateDefect);
  reqList(doc, 'unverified', 'evaluation', errors, validateUnverified);

  return { ok: errors.length === 0, errors };
}

/**
 * Элемент `steps[]` QA: `id` шага нужен для ссылок `qa:<id>` (D8).
 * @param {unknown} item
 * @param {string} path
 * @param {string[]} errors
 * @returns {void}
 */
function validateQaStep(item, path, errors) {
  if (!isRecord(item)) {
    errors.push(`${path}: ожидается объект, получено ${describe(item)}`);
    return;
  }
  reqStr(item, 'id', path, errors, { pattern: QA_STEP_ID_PATTERN });
  reqStr(item, 'url', path, errors, { allowEmpty: false });
  reqStr(item, 'action', path, errors, { allowEmpty: false });
  reqStr(item, 'observed', path, errors);
  reqList(item, 'console_errors', path, errors, rawItem);
  reqList(item, 'failed_requests', path, errors, rawItem);
  reqNullable(item, 'cache_headers', path, errors, (value, valuePath, errs) => {
    if (isRecord(value)) return;
    str(value, valuePath, errs);
  });
}

/**
 * `qa-web.json` — сырые данные браузерной проверки (`docs/qa-web.md`).
 * @param {unknown} doc
 * @returns {ValidationResult}
 */
export function validateQaWeb(doc) {
  const errors = [];
  if (!isRecord(doc)) {
    return { ok: false, errors: [`qa-web: ожидается объект, получено ${describe(doc)}`] };
  }

  reqOneOf(doc, 'status', 'qa-web', errors, QA_STATUSES);
  reqNullable(doc, 'reason', 'qa-web', errors, (value, valuePath, errs) => {
    str(value, valuePath, errs);
  });
  reqList(doc, 'steps', 'qa-web', errors, validateQaStep);

  return { ok: errors.length === 0, errors };
}

/**
 * `decision.<n>.json` (§5.6). Списки — массивы непустых строк: `reasons`, `acquire`,
 * `rework_items`, `unverified`, `downgraded`.
 * @param {unknown} doc
 * @returns {ValidationResult}
 */
export function validateDecision(doc) {
  const errors = [];
  if (!isRecord(doc)) {
    return { ok: false, errors: [`decision: ожидается объект, получено ${describe(doc)}`] };
  }

  reqInt(doc, 'iteration', 'decision', errors, { min: 1 });
  const actionOk = reqOneOf(doc, 'action', 'decision', errors, DECISION_ACTIONS);

  const retryPath = 'decision.retry_stage';
  const retryStage = req(doc, 'retry_stage', retryPath, errors);
  if (retryStage !== null) oneOf(retryStage, retryPath, errors, RETRY_STAGES);
  if (actionOk && doc.action === 'RETRY_STAGE' && retryStage === null) {
    errors.push('decision.retry_stage: обязателен при action = RETRY_STAGE');
  }

  for (const key of ['acquire', 'reasons', 'rework_items', 'unverified', 'downgraded']) {
    reqList(doc, key, 'decision', errors, textItem);
  }

  reqRecord(doc, 'counts', 'decision', errors, (counts, path, errs) => {
    for (const [key, value] of Object.entries(counts))
      int(value, `${path}.${key}`, errs, { min: 0 });
  });

  reqInt(doc, 'unresolved_refs', 'decision', errors, { min: 0 });

  return { ok: errors.length === 0, errors };
}

/**
 * `escalation.json` (Приложение A, словарь причин D7).
 * @param {unknown} doc
 * @returns {ValidationResult}
 */
export function validateEscalation(doc) {
  const errors = [];
  if (!isRecord(doc)) {
    return { ok: false, errors: [`escalation: ожидается объект, получено ${describe(doc)}`] };
  }

  escalationFields(doc, 'escalation', errors);
  reqList(doc, 'open_items', 'escalation', errors, textItem);

  return { ok: errors.length === 0, errors };
}

/**
 * Одно поле-счётчик серьёзности: объект `{ <SEVERITY>: целое ≥ 0 }` (Приложение A,
 * `metrics.json`). Лишние ключи игнорируются, как и во всех остальных схемах.
 * @param {unknown} parent
 * @param {string} key
 * @param {string} prefix
 * @param {string[]} errors
 * @param {readonly string[]} severities
 * @returns {void}
 */
function reqSeverityCounts(parent, key, prefix, errors, severities) {
  reqRecord(parent, key, prefix, errors, (counts, path, errs) => {
    for (const severity of severities) reqInt(counts, severity, path, errs, { min: 0 });
  });
}

/**
 * Сумма длительностей карты. Ключи сортируются, чтобы порядок полей в файле не влиял
 * ни на результат сравнения, ни на текст сообщения об ошибке.
 * @param {Record<string, number>} map проверенная карта длительностей
 * @returns {number}
 */
function sumDurations(map) {
  const total = Object.keys(map)
    .sort()
    .reduce((sum, key) => sum + map[key], 0);
  return Math.round(total * 1e6) / 1e6;
}

/**
 * Обязательное равенство из Приложения A: итог равен сумме карты длительностей
 * (`cycle_duration_s` → `stage_durations_s`, `gate_total_s` → `gate_durations_s`).
 * Вызывается только если карта и итог прошли проверку по отдельности: иначе поверх
 * уже найденных ошибок появилось бы шумное расхождение с суммой.
 * @param {Record<string, number>} map карта длительностей
 * @param {number} total итог
 * @param {string} mapName имя карты для сообщения
 * @param {string} totalPath путь итога для сообщения
 * @param {string[]} errors накопитель ошибок
 * @returns {void}
 */
function requireTotalOfMap(map, total, mapName, totalPath, errors) {
  const sum = sumDurations(map);
  if (Math.abs(total - sum) <= DURATION_TOLERANCE) return;
  errors.push(`${totalPath}: не равен сумме ${mapName} (${total} ≠ ${sum})`);
}

/**
 * `metrics.json` (Приложение A, §5.8). Метрика считается за весь цикл: длительности
 * этапов и гейтов, исходы гейтов, счётчики серьёзности, сопоставление находок ревью
 * с дефектами оценщика. `tokens` и `cost_rub` — факты расхода (§5.8): `tokens`
 * заполняется из `usage.json` (пишет `cycle-usage` по транскриптам субагентов),
 * `cost_rub` — те же токены по `evals/prices.json`. Оба `null`, когда замера нет:
 * `null` значит «не измеряли», а не «ноль». Частичный расход тоже даёт `null`:
 * неполная сумма выдавала бы себя за полную.
 *
 * Ключи `stage_durations_s` — имена этапов автомата §5.3, ключи `gate_durations_s`
 * и `gate_outcomes` — идентификаторы гейтов §5.5. Значения длительностей — секунды
 * (число ≥ 0 c точностью до 3 знаков; точность держит писатель, схема её не проверяет).
 *
 * Кроме типов проверяются обязательные равенства Приложения A: `cycle_duration_s`
 * равен сумме `stage_durations_s`, `gate_total_s` — сумме `gate_durations_s`. Сравнение
 * с допуском `DURATION_TOLERANCE` (писатель складывает уже округлённые слагаемые)
 * и только для тех карт, которые прошли проверку целиком.
 * @param {unknown} doc
 * @returns {ValidationResult}
 */
export function validateMetrics(doc) {
  const errors = [];
  if (!isRecord(doc)) {
    return { ok: false, errors: [`metrics: ожидается объект, получено ${describe(doc)}`] };
  }

  reqInt(doc, 'iterations', 'metrics', errors, { min: 1 });
  reqInt(doc, 'max_iterations', 'metrics', errors, { min: 1 });
  reqOneOf(doc, 'final_stage', 'metrics', errors, STAGES);

  // Карта проверяется целиком: пока в ней есть ошибка, сумму не считаем — иначе
  // поверх найденного добавилось бы шумное расхождение с итогом.
  let stageEntriesOk = true;
  const stagesRecorded = reqRecord(
    doc,
    'stage_durations_s',
    'metrics',
    errors,
    (map, path, errs) => {
      for (const [stage, value] of Object.entries(map)) {
        if (!STAGES.includes(stage)) {
          errs.push(`${path}: неизвестный этап ${describe(stage)}`);
          stageEntriesOk = false;
        }
        if (!num(value, `${path}.${stage}`, errs, { min: 0 })) stageEntriesOk = false;
      }
    },
  );

  const totalPath = 'metrics.cycle_duration_s';
  const cycleDurationOk = num(req(doc, 'cycle_duration_s', totalPath, errors), totalPath, errors, {
    min: 0,
  });

  if (stagesRecorded && stageEntriesOk && cycleDurationOk) {
    requireTotalOfMap(
      /** @type {Record<string, number>} */ (doc.stage_durations_s),
      /** @type {number} */ (doc.cycle_duration_s),
      'stage_durations_s',
      totalPath,
      errors,
    );
  }

  let gateEntriesOk = true;
  const gatesRecorded = reqRecord(doc, 'gate_durations_s', 'metrics', errors, (map, path, errs) => {
    for (const [id, value] of Object.entries(map)) {
      if (!GATE_ID_PATTERN.test(id)) {
        errs.push(`${path}: недопустимый id гейта ${describe(id)}`);
        gateEntriesOk = false;
      }
      if (!num(value, `${path}.${id}`, errs, { min: 0 })) gateEntriesOk = false;
    }
  });

  const gateTotalPath = 'metrics.gate_total_s';
  const gateTotalOk = num(req(doc, 'gate_total_s', gateTotalPath, errors), gateTotalPath, errors, {
    min: 0,
  });

  if (gatesRecorded && gateEntriesOk && gateTotalOk) {
    requireTotalOfMap(
      /** @type {Record<string, number>} */ (doc.gate_durations_s),
      /** @type {number} */ (doc.gate_total_s),
      'gate_durations_s',
      gateTotalPath,
      errors,
    );
  }

  reqRecord(doc, 'gate_outcomes', 'metrics', errors, (map, path, errs) => {
    for (const [id, value] of Object.entries(map)) {
      const valuePath = `${path}.${id}`;
      if (!GATE_ID_PATTERN.test(id)) errs.push(`${path}: недопустимый id гейта ${describe(id)}`);
      record(value, valuePath, errs, (counts, countsPath, countErrs) => {
        for (const status of GATE_STATUSES)
          reqInt(counts, status, countsPath, countErrs, { min: 0 });
      });
    }
  });

  reqSeverityCounts(doc, 'review_findings', 'metrics', errors, SEVERITIES);
  reqSeverityCounts(doc, 'evaluator_defects', 'metrics', errors, DEFECT_SEVERITIES);

  reqInt(doc, 'only_review', 'metrics', errors, { min: 0 });
  reqInt(doc, 'only_evaluator', 'metrics', errors, { min: 0 });
  reqInt(doc, 'both', 'metrics', errors, { min: 0 });
  reqInt(doc, 'unresolved_refs', 'metrics', errors, { min: 0 });
  reqInt(doc, 'verdict_without_evidence', 'metrics', errors, { min: 0 });
  reqInt(doc, 'unclosed_stages', 'metrics', errors, { min: 0 });

  reqBool(doc, 'evaluator_shares_family_with_plan', 'metrics', errors);

  // `tokens`: null либо карта «этап → суммы». Этапы — только те, где вызывается модель:
  // у гейтов и QA токенов нет, и лишний ключ означал бы расход не по тому словарю.
  reqNullable(doc, 'tokens', 'metrics', errors, (value, valuePath, errs) => {
    if (!isRecord(value)) {
      errs.push(`${valuePath}: ожидается объект этапов или null`);
      return;
    }
    for (const [stage, entry] of Object.entries(value)) {
      const stagePath = `${valuePath}.${stage}`;
      if (!MODEL_STAGES.includes(stage)) {
        errs.push(`${stagePath}: неизвестный этап (ожидается ${MODEL_STAGES.join('|')})`);
        continue;
      }
      if (!isRecord(entry)) {
        errs.push(`${stagePath}: ожидается объект сумм`);
        continue;
      }
      for (const field of MODEL_USAGE_FIELDS) {
        reqInt(entry, field, stagePath, errs, { min: 0 });
      }
    }
  });

  reqNullable(doc, 'cost_rub', 'metrics', errors, (value, valuePath, errs) => {
    num(value, valuePath, errs, { min: 0 });
  });

  return { ok: errors.length === 0, errors };
}
