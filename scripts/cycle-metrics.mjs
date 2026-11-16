#!/usr/bin/env node
/**
 * Метрики завершённого цикла по docs/orchestrator-core.md §5.8 (issue #160, задача T8).
 *
 * Вход: `state.json` (обязателен), `gates.<n>.json` (обязателен для каждой итерации
 * `1..state.iteration`), `review.<n>.json`, `evaluation.<n>.json`, `decision.<n>.json`
 * (опциональны). Выход: `metrics.json` в каталоге цикла и одна строка JSON того же
 * документа в stdout. Диагностика — в stderr.
 *
 * Почему md не разбирается: единственный автор `review/evaluation.<n>.json` —
 * `cycle-decide` (D4), он пишет их только из валидного блока ```json. Метрики читают
 * уже нормализованные файлы и не дублируют разбор вывода агентов.
 *
 * Что считается и откуда:
 * - `stage_durations_s` — сумма `finished_at - started_at` по `state.history` для каждого
 *   этапа; записи без `finished_at` не считаются и видны в `unclosed_stages`. ISO со
 *   смещением даёт абсолютное время, поэтому полночь и часовой пояс на длительность
 *   не влияют;
 * - `cycle_duration_s` — сумма `stage_durations_s`, а не `updated_at - started_at`:
 *   в последнем сидят паузы супервизора между этапами;
 * - `gate_durations_s` и `gate_outcomes` — по всем итерациям: метрика описывает цикл,
 *   а поитерационные детали уже есть в `gates.<n>.json`;
 * - `review_findings` / `evaluator_defects` — суммы по итерациям из нормализованных
 *   артефактов ревью и оценки;
 * - `only_review` / `only_evaluator` / `both` — сопоставление находок с дефектами
 *   оценщика внутри одной итерации (диффы итераций разные, сравнивать между ними
 *   нечего): тот же файл и `|Δline| ≤ 5` (§5.6), жадно в порядке следования, каждый
 *   элемент участвует не больше одного раза. `preexisting` участвует: правило §5.6
 *   исключений для метрики не делает. Находка с пустым/нечисловым `file:line` и дефект
 *   без разбираемых ссылок в `evidence[]` не сопоставляются и попадают в `only_*`;
 * - `unresolved_refs` и `verdict_without_evidence` — суммы из `decision.<n>.json`;
 * - `evaluator_shares_family_with_plan` — вычисляется из `state.models` (§5.9: семейство —
 *   второй сегмент `model`). До T7 агента `evaluate` нет, ключа в `state.models` тоже,
 *   и тогда значение `true` по R2: независимость оценщика не подтверждена, поэтому
 *   консервативно фиксируем «в одном семействе», а не выдаём желаемое за факт;
 * - `tokens` и `cost_rub` — `null`: сбор usage и бюджеты в поставку не входят (R5).
 *
 * Отсутствие `review`/`evaluation`/`decision` у итерации — не ошибка: цикл мог
 * эскалироваться раньше REVIEW, и вклад такой итерации в счётчики нулевой.
 *
 * Точность: длительности округляются до 3 знаков (миллисекунды). Суммы считаются
 * по округлённым слагаемым, поэтому `cycle_duration_s` равен сумме `stage_durations_s`,
 * а `gate_total_s` — сумме `gate_durations_s`. `-0` приводится к `0`, `NaN` и `Infinity`
 * недопустимы: неразбираемая дата в `history` — отказ (код 2) с указанием записи,
 * а не тихий ноль.
 *
 * Детерминизм: нет дат генерации и случайности, всё записываемое проходит `normalizeDoc`
 * (глубокая сортировка ключей). Повторный запуск на тех же входах даёт побайтно тот же
 * файл — это же свойство используется тестами и позволяет пересчитывать метрики при
 * досрочном вызове.
 *
 * Диагностика не содержит абсолютных путей и стектрейса (как в `check-harness.mjs`):
 * сообщения строятся из имён артефактов внутри каталога цикла, системный текст ошибок
 * Node (в нём есть абсолютный путь) не печатается — вместо него `error.code`.
 *
 * Коды выхода: `0` — `metrics.json` записан; `2` — ошибка использования или данных
 * (нет/битый `state.json` или `gates.<n>.json`, нарушена схема, мусор в аргументах).
 * Shebang нужен: файл запускается напрямую.
 */
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeDoc } from './cycle-decide.mjs';
import { readJson, writeJsonAtomic } from './lib/cycle/io.mjs';
import {
  FIXED_NAMES,
  artifactsDir,
  findActiveCycle,
  iterNames,
  repoRoot,
} from './lib/cycle/paths.mjs';
import {
  validateDecision,
  validateEvaluation,
  validateGates,
  validateMetrics,
  validateReview,
  validateState,
} from './lib/cycle/validate.mjs';

/** Серьёзность находки ревью (Приложение A): все четыре значения считаются. */
const REVIEW_SEVERITIES = Object.freeze(['BLOCKER', 'MAJOR', 'MINOR', 'FOLLOW-UP']);

/** Серьёзность дефекта оценщика: `FOLLOW-UP` у него не бывает. */
const DEFECT_SEVERITIES = Object.freeze(['BLOCKER', 'MAJOR', 'MINOR']);

/** Статусы гейта (§5.5) — по ним ведутся исходы. */
const GATE_STATUSES = Object.freeze(['pass', 'fail', 'skipped', 'not_run']);

/** Допуск сопоставления находок в строках (§5.6). */
export const LINE_TOLERANCE = 5;

/** Знаков после запятой у длительностей в секундах. */
const DURATION_DIGITS = 3;

/** Множитель округления длительностей. */
const DURATION_FACTOR = 10 ** DURATION_DIGITS;

/**
 * @typedef {object} IterationInputs
 * @property {number} iteration номер итерации, целое ≥ 1
 * @property {Record<string, any>} gates проверенный `gates.<n>.json`
 * @property {Record<string, any>|null} review проверенный `review.<n>.json` или `null`
 * @property {Record<string, any>|null} evaluation проверенный `evaluation.<n>.json` или `null`
 * @property {Record<string, any>|null} decision проверенный `decision.<n>.json` или `null`
 */

/**
 * @typedef {object} Metrics
 * @property {number} iterations
 * @property {number} max_iterations
 * @property {string} final_stage
 * @property {Record<string, number>} stage_durations_s
 * @property {number} cycle_duration_s
 * @property {Record<string, number>} gate_durations_s
 * @property {number} gate_total_s
 * @property {Record<string, Record<string, number>>} gate_outcomes
 * @property {Record<string, number>} review_findings
 * @property {Record<string, number>} evaluator_defects
 * @property {number} only_review
 * @property {number} only_evaluator
 * @property {number} both
 * @property {number} unresolved_refs
 * @property {number} verdict_without_evidence
 * @property {number} unclosed_stages
 * @property {boolean} evaluator_shares_family_with_plan
 * @property {null} tokens
 * @property {null} cost_rub
 */

/**
 * Плоский объект: массивы и `null` объектами не считаются.
 * @param {unknown} value
 * @returns {boolean}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Секунды с фиксированной точностью. `-0` приводится к `0`, нечисло — исключение:
 * молча подставлять ноль нельзя, это скрыло бы битые входные данные.
 * @param {number} seconds
 * @param {string} label путь для сообщения
 * @returns {number}
 */
function roundSeconds(seconds, label) {
  if (!Number.isFinite(seconds)) {
    throw new Error(`${label}: длительность не является конечным числом`);
  }
  const rounded = Math.round(seconds * DURATION_FACTOR) / DURATION_FACTOR;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Момент времени из ISO-8601. `Date.parse` понимает и `Z`, и смещение `+03:00`,
 * поэтому сравнивать можно записи с разными зонами.
 * @param {unknown} value
 * @param {string} label путь для сообщения
 * @returns {number} миллисекунды с начала эпохи
 */
function parseTime(value, label) {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new Error(`${label}: не разбирается как дата ISO-8601`);
  }
  return ms;
}

/**
 * Неотрицательный целый счётчик.
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function countOf(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label}: ожидается целое ≥ 0`);
  }
  return value;
}

/**
 * Сумма значений карты; порядок ключей на результат не влияет.
 * @param {Record<string, number>} map
 * @returns {number}
 */
function sumValues(map) {
  return Object.values(map).reduce((total, value) => total + value, 0);
}

/**
 * Позиция находки ревью: `file` после `trim` непустой и `line` — целое ≥ 1.
 * Всё остальное (`""`, `null`, строка, дробное) позицией не считается: такую находку
 * сопоставить не с чем (§5.6).
 * @param {unknown} finding
 * @returns {{ file: string, line: number }|null}
 */
function findingPosition(finding) {
  if (!isRecord(finding)) return null;
  const file = typeof finding.file === 'string' ? finding.file.trim() : '';
  const line = finding.line;
  if (file === '' || !Number.isInteger(line) || line < 1) return null;
  return { file, line };
}

/** Ссылка `path:line` из `evidence[]` оценщика: файл непустой, строка — целое ≥ 1. */
const REF_PATTERN = /^(.+):([1-9]\d*)$/;

/**
 * Позиции дефекта оценщика. У дефекта нет собственных `file`/`line` (Приложение A),
 * поэтому место берётся из его свидетельств вида `path:line`; ссылки `gate:<id>` и
 * `qa:<id>` позицией не являются. Дефект без разбираемых ссылок сопоставить не с чем.
 * @param {unknown} defect
 * @returns {{ file: string, line: number }[]}
 */
function defectPositions(defect) {
  if (!isRecord(defect) || !Array.isArray(defect.evidence)) return [];
  const positions = [];
  for (const ref of defect.evidence) {
    if (typeof ref !== 'string') continue;
    const match = REF_PATTERN.exec(ref.trim());
    if (match === null) continue;
    const file = match[1].trim();
    if (file === '') continue;
    positions.push({ file, line: Number(match[2]) });
  }
  return positions;
}

/**
 * Совпадает ли позиция находки с одной из позиций дефекта: тот же файл и
 * `|Δline| ≤ LINE_TOLERANCE` (§5.6).
 * @param {{ file: string, line: number }} finding
 * @param {{ file: string, line: number }[]} positions
 * @returns {boolean}
 */
function positionMatches(finding, positions) {
  return positions.some(
    (position) =>
      position.file === finding.file && Math.abs(position.line - finding.line) <= LINE_TOLERANCE,
  );
}

/**
 * Сопоставление находок ревью с дефектами оценщика (§5.6, «совпали»). Чистая функция:
 * порядок обхода фиксирован — находки в порядке следования, к каждой берётся первый
 * ещё не занятый дефект. Каждый элемент участвует не больше одного раза, поэтому
 * `both + only_review` равно числу находок, а `both + only_evaluator` — числу дефектов.
 * @param {Record<string, any>|null} review проверенный `review.<n>.json` или `null`
 * @param {Record<string, any>|null} evaluation проверенный `evaluation.<n>.json` или `null`
 * @returns {{ only_review: number, only_evaluator: number, both: number }}
 */
export function matchFindings(review, evaluation) {
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  const defects = Array.isArray(evaluation?.defects) ? evaluation.defects : [];
  const positions = defects.map(defectPositions);
  const used = new Array(defects.length).fill(false);

  let both = 0;
  let onlyReview = 0;

  for (const finding of findings) {
    const position = findingPosition(finding);
    const match =
      position === null
        ? -1
        : positions.findIndex((item, index) => !used[index] && positionMatches(position, item));

    if (match === -1) {
      onlyReview += 1;
      continue;
    }
    used[match] = true;
    both += 1;
  }

  return {
    only_review: onlyReview,
    only_evaluator: used.filter((value) => !value).length,
    both,
  };
}

/**
 * Семейство модели — второй сегмент `polza-ai/<семейство>/<модель>` (§5.9).
 * `null` — семейство вычислить нельзя: строки нет, сегментов меньше трёх или второй пуст.
 * @param {unknown} model
 * @returns {string|null}
 */
function modelFamily(model) {
  if (typeof model !== 'string') return null;
  const segments = model.split('/');
  if (segments.length < 3) return null;
  const family = segments[1].trim();
  return family === '' ? null : family;
}

/**
 * Оценщик в одном семействе с планом (предупреждение о потере независимости).
 *
 * Значение `true` означает «в том же семействе или это неизвестно»: метрика должна
 * предупреждать, а не успокаивать, поэтому неопределённость трактуется как совпадение.
 * Ключа `evaluate` в `state.models` до T7 нет (агент появится в T7), и по R2 в этом
 * случае возвращается `true` — иначе отсутствие данных читалось бы как подтверждённая
 * независимость. По той же причине не сравнивается `review`: пока оценивает ревьюер,
 * вопрос «оценщик против плана» ещё не имеет ответа.
 * @param {unknown} models `state.models`
 * @returns {boolean}
 */
export function evaluatorSharesFamilyWithPlan(models) {
  if (!isRecord(models)) return true;
  const evaluate = models.evaluate;
  if (typeof evaluate !== 'string') return true;
  const planFamily = modelFamily(models.plan);
  const evaluateFamily = modelFamily(evaluate);
  if (planFamily === null || evaluateFamily === null) return true;
  return planFamily === evaluateFamily;
}

/**
 * Считает метрики цикла. Чистая функция: файлов не читает и не пишет, время и
 * случайность не использует — на одних и тех же входах результат совпадает.
 *
 * Ожидает уже проверенные валидаторами документы, но не полагается на это: битая дата,
 * отрицательная или нечисловая длительность и нечисловые счётчики — исключение с
 * указанием записи (`state.history[i]`, `gates.<n>`), а не тихий ноль.
 * @param {{ state: Record<string, any>, iterations: IterationInputs[] }} inputs
 * @returns {Metrics}
 */
export function buildMetrics({ state, iterations }) {
  /** @type {Record<string, number>} */
  const stageTotals = {};
  const history = Array.isArray(state.history) ? state.history : [];
  let unclosed = 0;

  history.forEach((entry, index) => {
    const label = `state.history[${index}]`;
    if (!isRecord(entry)) throw new Error(`${label}: ожидается объект записи истории`);
    if (entry.finished_at === null || entry.finished_at === undefined) {
      unclosed += 1;
      return;
    }
    const started = parseTime(entry.started_at, `${label}.started_at`);
    const finished = parseTime(entry.finished_at, `${label}.finished_at`);
    const seconds = (finished - started) / 1000;
    if (seconds < 0) throw new Error(`${label}: finished_at раньше started_at`);
    const stage = String(entry.stage);
    stageTotals[stage] = (stageTotals[stage] ?? 0) + seconds;
  });

  /** @type {Record<string, number>} */
  const stageDurations = {};
  for (const [stage, seconds] of Object.entries(stageTotals)) {
    stageDurations[stage] = roundSeconds(seconds, `stage_durations_s.${stage}`);
  }

  /** @type {Record<string, number>} */
  const gateTotals = {};
  /** @type {Record<string, Record<string, number>>} */
  const gateOutcomes = {};
  /** @type {Record<string, number>} */
  const reviewFindings = Object.fromEntries(REVIEW_SEVERITIES.map((severity) => [severity, 0]));
  /** @type {Record<string, number>} */
  const evaluatorDefects = Object.fromEntries(DEFECT_SEVERITIES.map((severity) => [severity, 0]));
  let onlyReview = 0;
  let onlyEvaluator = 0;
  let both = 0;
  let unresolvedRefs = 0;
  let verdictWithoutEvidence = 0;

  for (const item of iterations) {
    const label = `gates.${item.iteration}`;
    const entries = Array.isArray(item.gates?.gates) ? item.gates.gates : [];

    entries.forEach((gate, index) => {
      const gateLabel = `${label}.gates[${index}]`;
      if (!isRecord(gate) || typeof gate.id !== 'string') {
        throw new Error(`${gateLabel}.id: ожидается строка`);
      }
      const duration = gate.duration_s;
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
        throw new Error(`${gateLabel}.duration_s: ожидается число ≥ 0`);
      }
      if (!GATE_STATUSES.includes(gate.status)) {
        throw new Error(`${gateLabel}.status: ожидается одно из ${GATE_STATUSES.join('|')}`);
      }

      gateTotals[gate.id] = (gateTotals[gate.id] ?? 0) + duration;
      gateOutcomes[gate.id] ??= Object.fromEntries(GATE_STATUSES.map((status) => [status, 0]));
      gateOutcomes[gate.id][gate.status] += 1;
    });

    const review = item.review ?? null;
    const evaluation = item.evaluation ?? null;

    for (const finding of Array.isArray(review?.findings) ? review.findings : []) {
      const severity = finding?.severity;
      if (Object.hasOwn(reviewFindings, severity)) reviewFindings[severity] += 1;
    }
    for (const defect of Array.isArray(evaluation?.defects) ? evaluation.defects : []) {
      const severity = defect?.severity;
      if (Object.hasOwn(evaluatorDefects, severity)) evaluatorDefects[severity] += 1;
    }

    const match = matchFindings(review, evaluation);
    onlyReview += match.only_review;
    onlyEvaluator += match.only_evaluator;
    both += match.both;

    if (item.decision !== null) {
      const decisionLabel = `decision.${item.iteration}`;
      unresolvedRefs += countOf(item.decision.unresolved_refs, `${decisionLabel}.unresolved_refs`);
      const counts = isRecord(item.decision.counts) ? item.decision.counts : {};
      verdictWithoutEvidence += countOf(
        counts.verdict_without_evidence ?? 0,
        `${decisionLabel}.counts.verdict_without_evidence`,
      );
    }
  }

  /** @type {Record<string, number>} */
  const gateDurations = {};
  for (const [id, seconds] of Object.entries(gateTotals)) {
    gateDurations[id] = roundSeconds(seconds, `gate_durations_s.${id}`);
  }

  return {
    iterations: countOf(state.iteration, 'state.iteration'),
    max_iterations: countOf(state.max_iterations, 'state.max_iterations'),
    final_stage: String(state.stage),
    stage_durations_s: stageDurations,
    cycle_duration_s: roundSeconds(sumValues(stageDurations), 'cycle_duration_s'),
    gate_durations_s: gateDurations,
    gate_total_s: roundSeconds(sumValues(gateDurations), 'gate_total_s'),
    gate_outcomes: gateOutcomes,
    review_findings: reviewFindings,
    evaluator_defects: evaluatorDefects,
    only_review: onlyReview,
    only_evaluator: onlyEvaluator,
    both,
    unresolved_refs: unresolvedRefs,
    verdict_without_evidence: verdictWithoutEvidence,
    unclosed_stages: unclosed,
    evaluator_shares_family_with_plan: evaluatorSharesFamilyWithPlan(state.models),
    tokens: null,
    cost_rub: null,
  };
}

/**
 * Разбирает аргументы командной строки. Любой мусор — ошибка использования (код 2).
 * @param {string[]} argv
 * @returns {{ dir: string|null }}
 */
export function parseArgs(argv) {
  /** @type {string|null} */
  let dir = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
        throw new Error('--dir: ожидается путь к каталогу цикла');
      }
      dir = value;
      index += 1;
      continue;
    }
    throw new Error(`неизвестный аргумент: ${arg}`);
  }

  return { dir };
}

/**
 * Читаемое представление артефакта: два пробела и завершающий перевод строки —
 * как у остальных артефактов цикла.
 * @param {unknown} data
 * @returns {string}
 */
function serializeArtifact(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** Причины ошибок чтения по `error.code`: системный текст Node содержит абсолютный путь. */
const READ_ERROR_REASONS = Object.freeze({
  ENOENT: 'файл не найден',
  EACCES: 'нет доступа на чтение',
  EPERM: 'нет доступа на чтение',
  EISDIR: 'ожидался файл, а не каталог',
});

/**
 * Человекочитаемая причина ошибки чтения.
 * @param {unknown} error
 * @returns {string}
 */
function describeReadError(error) {
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
function describeJsonError(error) {
  if (!(error instanceof Error)) return 'ошибка разбора JSON';
  const reason = error.message
    .split(/\r?\n/u)[0]
    .replace(/,\s*".*$/u, '')
    .replace(/ in JSON at position.*$/u, '')
    .trim();
  return reason === '' ? 'ошибка разбора JSON' : reason;
}

/**
 * Читает обязательный JSON-артефакт и проверяет схему. Сообщения содержат только имя
 * артефакта внутри каталога цикла — без абсолютных путей.
 * @param {string} file
 * @param {(doc: unknown) => { ok: boolean, errors: string[] }} validator
 * @param {string} label имя артефакта для сообщения
 * @returns {Record<string, any>}
 */
function readRequiredJson(file, validator, label) {
  /** @type {unknown} */
  let doc;
  try {
    doc = readJson(file);
  } catch (error) {
    // Ошибки доступа к файлу приходят с `error.code`, ошибки разбора JSON — без него.
    const code = /** @type {{ code?: unknown } | undefined} */ (error)?.code;
    const reason = typeof code === 'string' ? describeReadError(error) : describeJsonError(error);
    throw new Error(`${label}: не читается (${reason})`, { cause: error });
  }

  const result = validator(doc);
  if (!result.ok) {
    throw new Error(`${label}: схема нарушена:\n${result.errors.join('\n')}`);
  }
  return /** @type {Record<string, any>} */ (doc);
}

/**
 * Читает необязательный JSON-артефакт: отсутствие файла — `null`, порча или нарушение
 * схемы — отказ (повреждённый артефакт исказил бы метрику молча).
 * @param {string} file
 * @param {(doc: unknown) => { ok: boolean, errors: string[] }} validator
 * @param {string} label
 * @returns {Record<string, any>|null}
 */
function readOptionalJson(file, validator, label) {
  if (!existsSync(file)) return null;
  return readRequiredJson(file, validator, label);
}

/**
 * Входы всех итераций `1..state.iteration`. `gates.<n>.json` обязателен: без него
 * итерация не дала ни одной метрики гейтов, и нули были бы догадкой.
 * @param {string} dir каталог цикла
 * @param {Record<string, any>} state проверенный `state.json`
 * @returns {IterationInputs[]}
 */
function readIterations(dir, state) {
  /** @type {IterationInputs[]} */
  const iterations = [];

  for (let iteration = 1; iteration <= state.iteration; iteration += 1) {
    const names = iterNames(iteration);
    iterations.push({
      iteration,
      gates: readRequiredJson(join(dir, names.gates), validateGates, names.gates),
      review: readOptionalJson(join(dir, names.reviewJson), validateReview, names.reviewJson),
      evaluation: readOptionalJson(
        join(dir, names.evaluationJson),
        validateEvaluation,
        names.evaluationJson,
      ),
      decision: readOptionalJson(join(dir, names.decision), validateDecision, names.decision),
    });
  }

  return iterations;
}

/**
 * Каталог цикла при запуске без `--dir`. Сообщение `findActiveCycle` содержит
 * абсолютный путь каталога артефактов; для диагностики он заменяется относительным.
 * @param {string} root корень репозитория
 * @returns {string} путь к каталогу активного цикла
 */
export function resolveCycleDir(root) {
  const dir = artifactsDir(root);
  try {
    return findActiveCycle(dir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.split(dir).join(relative(root, dir) || dir), { cause: error });
  }
}

/**
 * Точка входа CLI. Пишет только `metrics.json` в каталог цикла; единственный вывод —
 * строка JSON в stdout, диагностика — в stderr.
 * @returns {void}
 */
function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const root = repoRoot();
    const dir = args.dir === null ? resolveCycleDir(root) : resolve(args.dir);

    const state = readRequiredJson(join(dir, FIXED_NAMES.state), validateState, FIXED_NAMES.state);
    const metrics = buildMetrics({ state, iterations: readIterations(dir, state) });

    // Самопроверка: метрики обязаны проходить собственный валидатор (Приложение A).
    // Ошибка здесь — дефект писателя, а не входных данных, поэтому отдельный текст.
    const check = validateMetrics(metrics);
    if (!check.ok) {
      throw new Error(`metrics.json: нарушена схема (ошибка записи):\n${check.errors.join('\n')}`);
    }

    writeJsonAtomic(join(dir, FIXED_NAMES.metrics), normalizeDoc(metrics), {
      serialize: serializeArtifact,
    });
    process.stdout.write(`${JSON.stringify(normalizeDoc(metrics))}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cycle-metrics: ${message}\n`);
    process.exitCode = 2;
  }
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
