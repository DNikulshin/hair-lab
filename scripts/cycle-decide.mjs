#!/usr/bin/env node
/**
 * Решение цикла по docs/orchestrator-core.md §5.6 (issue #156, задача T5).
 *
 * Вход: `state.json`, `gates.<n>.json`, `review.<n>.md`, `evaluation.<n>.md`, `qa-web.json`.
 * Выход: `decision.<n>.json`; нормализованные `review.<n>.json` / `evaluation.<n>.json`
 * пишутся только при валидном блоке ```json из соответствующего md (D4). В stdout —
 * одна строка JSON решения.
 *
 * Решение детерминировано: нет времени, случайности и зависимости от порядка ключей
 * входных объектов — всё записываемое проходит `normalizeDoc` (глубокая сортировка
 * ключей), списки строятся в фиксированном порядке источников. Два прогона на одном
 * и том же состоянии дают побайтно одинаковые файлы.
 *
 * Правила §5.6 (порядок применения):
 * 1. невалидный вывод агента → `RETRY_STAGE` один раз на этап, повторно → `ESCALATE`;
 * 2. блокеры: required-гейт `fail`; валидные BLOCKER/MAJOR ревью и BLOCKER/MAJOR
 *    оценщика, критерий `unmet` со свидетельством; невалидные элементы → `downgraded`;
 * 3. есть блокеры → `REWORK`, на лимите итераций → `ESCALATE(iteration_limit)`;
 * 4. нет блокеров, но есть `unverified` → `ACQUIRE_EVIDENCE`, если есть что добрать и
 *    `retries.evidence < 1`, иначе `PROCEED_WITH_UNVERIFIED`;
 * 5. иначе `PROCEED`.
 *
 * `unverified` включает required-гейты `not_run` и в случае `reason = no_database`:
 * «(кроме no_database)» в §5.6 ограничивает только исполнимость `acquire[]` — T9
 * ожидает при отсутствии БД именно `PROCEED_WITH_UNVERIFIED` с отметкой в PR.
 *
 * Ссылки на `.env*` (кроме `.env.example`) не читаются (AGENTS.md, «Персональные данные
 * и безопасность»). Запрет держат два рубежа: `refs.mjs` отбивает такие пути, включая
 * симлинки и канонические пути (issue #167), а проверка здесь остаётся как ранний
 * лексический фильтр до вызова resolver. Ссылка становится неразрешимой: элемент
 * не блокирует и идёт в `downgraded`/`unresolved_refs` по общим правилам, а сам путь
 * в решение не попадает.
 *
 * `acquire[]` — то, что имеет смысл добрать: `gate:<id>` для required-гейта `not_run`
 * не по `no_database` и литерал `qa-web` при web-диффе без выполненной QA. Зависимый гейт
 * с `blocked_by:<id>` тоже попадает в список: `cycle-gates` пересчитывает зависимости
 * и запустит его, если родитель пройдёт. Список
 * заполняется и при `PROCEED_WITH_UNVERIFIED`: `cycle-state apply-decision` читает его
 * только для `ACQUIRE_EVIDENCE`, а отчёт показывает, что осталось непроверенным.
 *
 * `counts` (уточнение супервизора к плану): `blockers` — валидные BLOCKER-элементы
 * (BLOCKER ревью, defect BLOCKER, критерий `unmet`), `major` — валидные MAJOR
 * (MAJOR ревью в скоупе, defect MAJOR), `minor` — находки MINOR, `followups` —
 * находки FOLLOW-UP плюс `downgraded.length`, `partial_criteria` — критерии `partial`,
 * `verdict_without_evidence` — 0|1: вердикт оценщика `REWORK` без валидного блокера.
 * Провалившиеся гейты в `counts` не входят — они в `reasons[]`.
 *
 * Контракты строк (интерфейс для `cycle-state`/`cycle-pr-body`/`cycle-metrics`;
 * менять только вместе с тестами):
 * - `reasons[]`: `gate:<id>: fail`, `review:<SEV> <id>`, `evaluation:<SEV> <id>`,
 *   `criteria:<id> <status>`, `retry:<STAGE> agent_output_invalid`,
 *   `escalate:<reason>`; при невалидном выводе агента сразу за основной причиной идут
 *   `invalid:<STAGE> <файл>: <путь поля>: <что не так>` (до 5 штук, #247);
 * - `rework_items[]`: `<id> [SEV] <file:line> — <summary>; сценарий: <repro>` (ревью),
 *   `<id> [SEV] <свидетельство> — <claim>; сценарий: <repro>` (defect),
 *   `<id> [unmet] — <note>; свидетельства: <…>` (критерий),
 *   `gate:<id> [fail] — обязательный гейт не прошёл; лог: gates/<id>.<n>.log` (гейт);
 * - `unverified[]`: `gate:<id> not_run (<reason>)`, `qa-web not_run (<reason>)`,
 *   `criteria:<id> unverified`, `evaluation unverified: <what>`;
 * - `downgraded[]`: `<id> [<SEV>] <причина>` (у критерия вместо `SEV` — статус `unmet`);
 *   причины — фиксированный набор `DOWNGRADE_REASONS`.
 *
 * Маскирование (§5.4): свободный текст из вывода агентов попадает в строки решения только
 * через `redactLog` — `finding.summary`, `finding.repro`, `defect.claim`, `defect.repro`,
 * `criterion.note`, `unverified[].what`. Телефон, e-mail, JWT и прочие секреты в них
 * становятся `[phone]`/`[email]`/`[secret]`, поэтому ни `decision.<n>.json`, ни собранная
 * из него PR-сводка ПДн не разглашают. Не маскируются `id`, `file`, `line`, `severity`,
 * `status` и готовые ссылки `path:line`: иначе поедут контракты строк `rework_items[]`
 * и метрика `unresolved_refs`. В `reasons[]` свободного текста нет (только вид элемента,
 * серьёзность/статус и id), поэтому маскирование к нему не применяется. Единственное
 * исключение — пути полей из сообщений валидатора (`invalid:<STAGE> …`): это имена из
 * схемы Приложения A, а не данные цикла.
 *
 * Коды выхода: `0` — решение записано; `2` — ошибка использования или внутренняя
 * (нет/битый `state.json` или `gates.<n>.json`, битый `qa-web.json`, мусор в аргументах).
 * Shebang нужен: файл запускается напрямую.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { changedFiles } from './lib/cycle/git.mjs';
import { cycleCostRub, readPriceSnapshot } from './lib/cycle/cost.mjs';
import { describedLimits, resolveLimits } from './lib/cycle/limits.mjs';
import { extractLastJsonBlock, readJson, writeJsonAtomic } from './lib/cycle/io.mjs';
import { FIXED_NAMES, findActiveCycle, iterNames, repoRoot } from './lib/cycle/paths.mjs';
import { redactLog } from './lib/cycle/redact.mjs';
import { resolveRef } from './lib/cycle/refs.mjs';
import {
  validateEvaluation,
  validateGates,
  validateQaWeb,
  validateReview,
  validateState,
} from './lib/cycle/validate.mjs';

/** Этапы, повтор которых описан правилом 1 §5.6. */
const REVIEW_STAGE = 'REVIEW';
const EVALUATE_STAGE = 'EVALUATE';

/** Причина `not_run` гейта, при которой добор невозможен (нет БД). */
const NO_DATABASE = 'no_database';

/**
 * Сколько ошибок схемы попадает в `reasons[]` при невалидном выводе агента (#247).
 * Полный список всё равно печатается в stderr: решение не должно распухать.
 */
const INVALID_OUTPUT_LIMIT = 5;

/** Префикс путей web-приложения: по нему решается, нужна ли браузерная проверка. */
const WEB_PREFIX = 'apps/web';

/** Единственный разрешённый к чтению файл окружения (AGENTS.md, «Персональные данные»). */
const ENV_EXAMPLE = '.env.example';

/**
 * Причины понижения блокера до FOLLOW-UP (уточнение супервизора к плану, п. 3):
 * фиксированный набор, чтобы строка `downgraded` была предсказуемой для метрик.
 */
const DOWNGRADE_REASONS = Object.freeze({
  noPosition: 'нет пути и строки',
  noRepro: 'нет сценария воспроизведения',
  unresolvedRef: 'ссылка не разрешается',
  preexisting: 'найдено до правок (preexisting)',
  outOfScope: 'вне скоупа',
  noEvidence: 'нет свидетельства',
});

/**
 * @typedef {object} Retries
 * @property {number} REVIEW сколько раз уже повторяли ревью
 * @property {number} EVALUATE сколько раз уже повторяли оценку
 * @property {number} evidence сколько раз уже добирали свидетельства
 */

/**
 * @typedef {object} DecideInputs
 * @property {number} iteration номер итерации, целое ≥ 1
 * @property {number} maxIterations `state.max_iterations`
 * @property {Retries} retries `state.retries`
 * @property {{ gates?: unknown[] }} gates проверенный `gates.<n>.json`
 * @property {Record<string, any>|null} review проверенный блок ревью или `null`
 * @property {Record<string, any>|null} evaluation проверенный блок оценки или `null`
 * @property {{ status?: string, reason?: string|null, steps?: unknown[] }|null} qaWeb
 *   проверенный `qa-web.json` или `null`, если файла нет
 * @property {boolean} webDiff дифф затрагивает `apps/web`
 * @property {string} root корень репозитория для разрешения ссылок
 * @property {number|null} [costRub] стоимость цикла по `usage.json` и `evals/prices.json`:
 *   `null` (по умолчанию) — замера нет (нет `usage.json`, неизвестна модель или цены),
 *   и тогда бюджетный порог не проверяется: ноль был бы выдуманными данными
 * @property {Record<string, string[]>} [agentErrors] ошибки схемы по этапам
 *   (`REVIEW`/`EVALUATE`) из md-блока агента: первые `INVALID_OUTPUT_LIMIT` попадают
 *   в `reasons[]` при срабатывании правила 1 (#247)
 */

/**
 * @typedef {object} Decision
 * @property {number} iteration
 * @property {'REWORK'|'ACQUIRE_EVIDENCE'|'RETRY_STAGE'|'PROCEED'|'PROCEED_WITH_UNVERIFIED'|'ESCALATE'} action
 * @property {'REVIEW'|'EVALUATE'|null} retry_stage
 * @property {string[]} acquire
 * @property {string[]} reasons
 * @property {string[]} rework_items
 * @property {string[]} unverified
 * @property {string[]} downgraded
 * @property {Record<string, number>} counts
 * @property {number} unresolved_refs
 */

/**
 * Глубокая сортировка ключей: массивы сохраняют порядок, примитивы не меняются.
 * Нужна, чтобы файл решения не зависел от порядка ключей объектов входа (D4,
 * требование детерминизма §5.6/§5.10).
 * @param {unknown} value
 * @returns {unknown}
 */
export function normalizeDoc(value) {
  if (Array.isArray(value)) return value.map(normalizeDoc);
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = normalizeDoc(/** @type {Record<string, unknown>} */ (value)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Затрагивает ли дифф web-приложение: от этого зависит необходимость QA_WEB (§5.6, п. 4).
 * Список берётся из `git.changedFiles`, поэтому untracked видны только после
 * `git add --intent-to-add` (протокол Приложения B).
 * @param {string[]} files пути относительно корня репозитория
 * @returns {boolean}
 */
export function diffTouchesWeb(files) {
  return files.some((file) => file === WEB_PREFIX || file.startsWith(`${WEB_PREFIX}/`));
}

/**
 * Непустая строка после обрезки пробелов.
 * @param {unknown} value
 * @returns {boolean}
 */
function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Пользовательский свободный текст для строки решения: маскируется по §5.4.
 * Нестроковое значение приводится к строке — шаблонная строка вела себя так же,
 * но маскирование требует строки.
 * @param {unknown} value
 * @returns {string}
 */
function redacted(value) {
  return redactLog(typeof value === 'string' ? value : String(value));
}

/**
 * Ссылка находки ревью: `<file>:<line>` — единственная форма свидетельства, которая
 * есть в схеме ревью (Приложение A/B). Диапазоны бывают только в `evaluation.criteria[].
 * evidence`, поэтому здесь хвост один.
 * @param {Record<string, any>} finding
 * @returns {string|null}
 */
function findingRef(finding) {
  if (!isText(finding.file)) return null;
  const line = finding.line;
  if (!Number.isInteger(line) || line < 1) return null;
  return `${finding.file.trim()}:${line}`;
}

/**
 * Сегмент пути — файл `.env*`, кроме разрешённого `.env.example`.
 * Регистр не важен: на нечувствительной к регистру файловой системе `.ENV.local`
 * открыл бы тот же файл.
 * @param {string} segment
 * @returns {boolean}
 */
function isEnvSegment(segment) {
  const lower = segment.trim().toLowerCase();
  return lower.startsWith('.env') && lower !== ENV_EXAMPLE;
}

/**
 * Ведёт ли ссылка в `.env*`. Проверяется каждый сегмент пути, поэтому ловятся и
 * `.env`, `.env.local`, `.env.production`, и `./.env`, и вложенные `apps/api/.env.local`.
 * Номер строки или диапазон отрезается: `path:line` / `path:start-end` → `path`.
 * @param {unknown} ref
 * @returns {boolean}
 */
function isForbiddenEnvRef(ref) {
  if (typeof ref !== 'string') return false;
  return stripLineSuffix(ref).split('/').some(isEnvSegment);
}

/**
 * Отрезает хвост `:<строка>` или `:<начало>-<конец>` (#275): путь остаётся путём.
 * @param {string} ref
 * @returns {string}
 */
function stripLineSuffix(ref) {
  return ref.trim().replace(/:\d+(?:-\d+)?$/, '');
}

/**
 * Разрешает ссылку, не читая `.env*` (AGENTS.md: `.env*`, кроме `.env.example`,
 * не читать и не печатать). Ранний лексический фильтр до вызова resolver: основной
 * запрет — включая симлинки и канонические пути (issue #167) — держит `refs.mjs`,
 * здесь он остаётся как defense in depth, чтобы путь в `.env*` не доходил до чтения файла.
 * @param {string} ref
 * @param {import('./lib/cycle/refs.mjs').RefContext} ctx
 * @returns {import('./lib/cycle/refs.mjs').RefResolution}
 */
function safeResolveRef(ref, ctx) {
  if (!isForbiddenEnvRef(ref)) return resolveRef(ref, ctx);
  return {
    ok: false,
    ref,
    kind: 'path',
    value: stripLineSuffix(ref),
    line: null,
    endLine: null,
    file: null,
    error: 'файл .env* не читается (AGENTS.md)',
  };
}

/**
 * Разрешает ссылки и считает разрешённые и неразрешённые. `unresolved_refs` —
 * метрика качества свидетельств (§5.6), поэтому учитывается каждое вхождение.
 * @param {unknown[]} refs
 * @param {import('./lib/cycle/refs.mjs').RefContext} ctx
 * @returns {{ resolved: number, unresolved: number }}
 */
function countRefs(refs, ctx) {
  const counts = { resolved: 0, unresolved: 0 };
  for (const ref of refs) {
    if (safeResolveRef(ref, ctx).ok) counts.resolved += 1;
    else counts.unresolved += 1;
  }
  return counts;
}

/**
 * Причина понижения находки ревью или `null`, если BLOCKER/MAJOR валиден (§5.6, п. 2b).
 * Порядок проверок соответствует перечислению в §5.6.
 * @param {Record<string, any>} finding
 * @param {import('./lib/cycle/refs.mjs').RefResolution|null} resolution
 * @returns {string|null}
 */
function reviewDowngradeReason(finding, resolution) {
  if (findingRef(finding) === null) return DOWNGRADE_REASONS.noPosition;
  if (!isText(finding.repro)) return DOWNGRADE_REASONS.noRepro;
  if (resolution === null || !resolution.ok) return DOWNGRADE_REASONS.unresolvedRef;
  if (finding.preexisting === true) return DOWNGRADE_REASONS.preexisting;
  if (finding.severity === 'MAJOR' && finding.in_scope !== true)
    return DOWNGRADE_REASONS.outOfScope;
  return null;
}

/**
 * Причина понижения дефекта оценщика или `null`, если BLOCKER/MAJOR валиден
 * (§5.6, п. 2c: нужен `repro` и хотя бы одна разрешаемая ссылка).
 * @param {Record<string, any>} defect
 * @param {number} resolvedRefs
 * @returns {string|null}
 */
function defectDowngradeReason(defect, resolvedRefs) {
  if (!isText(defect.repro)) return DOWNGRADE_REASONS.noRepro;
  if (resolvedRefs < 1) return DOWNGRADE_REASONS.noEvidence;
  return null;
}

/**
 * Ошибки схемы этапа для `reasons[]`: не больше `INVALID_OUTPUT_LIMIT` штук и без
 * повторов (валидатор может сообщить одно и то же с разными путями). Это подсказка
 * агенту на повтор, а не замена полного вывода в stderr.
 * @param {Record<string, string[]>} agentErrors
 * @param {string} stage
 * @returns {string[]}
 */
function invalidOutputDetails(agentErrors, stage) {
  const list = agentErrors === null || agentErrors === undefined ? [] : agentErrors[stage];
  if (!Array.isArray(list)) return [];
  const unique = [...new Set(list.filter((item) => isText(item)))];
  return unique.slice(0, INVALID_OUTPUT_LIMIT);
}

/**
 * Расчёт решения цикла. Чистая функция: файлов не читает и не пишет, время и
 * случайность не использует — на одних и тех же входах результат совпадает.
 * @param {DecideInputs} inputs
 * @returns {Decision}
 */
/** Человекочитаемые источники лимита для текста причины бюджета. */
const LIMIT_SOURCE_LABELS = Object.freeze({
  cli: 'CLI-флаг',
  env: 'переменная окружения',
  config: '.pi/harness.config.json',
  default: 'дефолт ядра',
});

export function decide(inputs) {
  const {
    iteration,
    maxIterations,
    retries,
    gates,
    review,
    evaluation,
    qaWeb,
    webDiff,
    root,
    costRub = null,
    agentErrors = {},
  } = inputs;

  // Лимиты проекта (#235): CLI → env → `.pi/harness.config.json` → дефолт ядра.
  const resolvedLimits = resolveLimits({
    root: inputs.root ?? process.cwd(),
    cli: inputs.limits ?? {},
  });

  /** @type {Record<string, number>} */
  const counts = {
    blockers: 0,
    major: 0,
    minor: 0,
    followups: 0,
    partial_criteria: 0,
    verdict_without_evidence: 0,
  };
  /** @type {string[]} */
  const reasons = [];
  /** @type {string[]} */
  const reworkItems = [];
  /** @type {string[]} */
  const downgraded = [];
  /** @type {string[]} */
  const unverified = [];
  /** @type {string[]} */
  const acquire = [];
  /** Число блокирующих элементов: гейты, валидные находки и критерии (правило 3). */
  let blocking = 0;
  let unresolvedRefs = 0;

  /**
   * Собирает решение. Вызывается ровно один раз за расчёт: `counts.followups`
   * учитывает `downgraded`.
   * @param {Decision['action']} action
   * @param {{ retryStage?: Decision['retry_stage'], acquired?: string[] }} [options]
   * @returns {Decision}
   */
  function finalize(action, { retryStage = null, acquired = [] } = {}) {
    counts.followups += downgraded.length;
    return {
      iteration,
      action,
      retry_stage: retryStage,
      acquire: acquired,
      reasons,
      rework_items: reworkItems,
      unverified,
      downgraded,
      counts,
      unresolved_refs: unresolvedRefs,
      applied_limits: describedLimits(resolvedLimits),
    };
  }

  // Правило 7 (§5.6, §11): жёсткий бюджетный порог проверяется первым — цикл дороже
  // порога останавливается до любых доработок, ведь каждая из них тратит ещё. `null` —
  // замера нет, проверять нечего: порог не срабатывает, решение идёт по общим правилам.
  const budgetLimit = resolvedLimits.values.maxCycleCostRub;
  if (costRub !== null && costRub > budgetLimit) {
    const source =
      LIMIT_SOURCE_LABELS[resolvedLimits.sources.maxCycleCostRub] ?? 'источник неизвестен';
    reasons.push(`budget: ${costRub} ₽ > ${budgetLimit} ₽ (правило 7 §5.6, лимит: ${source})`);
    reasons.push('escalate:budget');
    return finalize('ESCALATE');
  }

  // Правило 1: невалидный вывод агента. Первым проверяется REVIEW (§5.6).
  const invalidStage = review === null ? REVIEW_STAGE : evaluation === null ? EVALUATE_STAGE : null;
  if (invalidStage !== null) {
    const stageRetries = invalidStage === REVIEW_STAGE ? retries.REVIEW : retries.EVALUATE;
    const retry = stageRetries < 1;
    reasons.push(
      retry ? `retry:${invalidStage} agent_output_invalid` : 'escalate:agent_output_invalid',
    );
    // Причина «agent_output_invalid» сама по себе не говорит, что чинить (#247):
    // рядом кладём пути полей из валидатора, полный список — в stderr CLI.
    for (const detail of invalidOutputDetails(agentErrors, invalidStage)) {
      reasons.push(`invalid:${invalidStage} ${detail}`);
    }
    return retry ? finalize('RETRY_STAGE', { retryStage: invalidStage }) : finalize('ESCALATE');
  }

  /** @type {import('./lib/cycle/refs.mjs').RefContext} */
  const ctx = { root, gates, qa: qaWeb };
  // Документы уже проверены валидаторами, но чистая функция не полагается на это:
  // тесты и будущие вызовы могут передать частичный документ.
  const gateEntries = Array.isArray(gates.gates) ? gates.gates : [];
  const findings = Array.isArray(review.findings) ? review.findings : [];
  const criteria = Array.isArray(evaluation.criteria) ? evaluation.criteria : [];
  const defects = Array.isArray(evaluation.defects) ? evaluation.defects : [];
  const evalUnverified = Array.isArray(evaluation.unverified) ? evaluation.unverified : [];

  // Правило 2a: провалившиеся required-гейты. В `counts` они не входят (§5.6, уточнение 2).
  for (const gate of gateEntries) {
    if (gate.required !== true || gate.status !== 'fail') continue;
    blocking += 1;
    reasons.push(`gate:${gate.id}: fail`);
    reworkItems.push(
      `gate:${gate.id} [fail] — обязательный гейт не прошёл; лог: gates/${gate.id}.${iteration}.log`,
    );
  }

  // Правило 2b: находки ревью. Ссылки разрешаются у всех находок — это метрика,
  // а блокируют только валидные BLOCKER и MAJOR в скоупе и не preexisting.
  for (const finding of findings) {
    const severity = finding.severity;
    if (severity === 'MINOR') counts.minor += 1;
    if (severity === 'FOLLOW-UP') counts.followups += 1;

    const ref = findingRef(finding);
    const resolution = ref === null ? null : safeResolveRef(ref, ctx);
    if (resolution !== null && !resolution.ok) unresolvedRefs += 1;

    if (severity !== 'BLOCKER' && severity !== 'MAJOR') continue;

    const problem = reviewDowngradeReason(finding, resolution);
    if (problem !== null) {
      downgraded.push(`${finding.id} [${severity}] ${problem}`);
      continue;
    }

    reasons.push(`review:${severity} ${finding.id}`);
    reworkItems.push(
      `${finding.id} [${severity}] ${ref} — ${redacted(finding.summary)}; сценарий: ${redacted(
        finding.repro,
      )}`,
    );
    if (severity === 'BLOCKER') counts.blockers += 1;
    else counts.major += 1;
    blocking += 1;
  }

  /** Критерии `unverified`: попадают в `unverified[]` правила 4. */
  /** @type {string[]} */
  const criteriaUnverified = [];

  // Правило 2c, критерии: `unmet` блокирует только со свидетельством.
  for (const criterion of criteria) {
    const status = criterion.status;
    const evidence = Array.isArray(criterion.evidence) ? criterion.evidence : [];
    const refs = countRefs(evidence, ctx);
    unresolvedRefs += refs.unresolved;

    if (status !== 'met') reasons.push(`criteria:${criterion.id} ${status}`);

    if (status === 'partial') {
      counts.partial_criteria += 1;
      continue;
    }
    if (status === 'unverified') {
      criteriaUnverified.push(`criteria:${criterion.id} unverified`);
      continue;
    }
    if (status !== 'unmet') continue;

    if (refs.resolved < 1) {
      downgraded.push(`${criterion.id} [unmet] ${DOWNGRADE_REASONS.noEvidence}`);
      continue;
    }

    counts.blockers += 1;
    blocking += 1;
    const note = isText(criterion.note) ? criterion.note.trim() : 'критерий не выполнен';
    reworkItems.push(
      `${criterion.id} [unmet] — ${redacted(note)}; свидетельства: ${evidence.join(', ')}`,
    );
  }

  // Правило 2c, дефекты: BLOCKER/MAJOR блокируют при `repro` и свидетельстве.
  for (const defect of defects) {
    const evidence = Array.isArray(defect.evidence) ? defect.evidence : [];
    const refs = countRefs(evidence, ctx);
    unresolvedRefs += refs.unresolved;

    if (defect.severity === 'MINOR') {
      counts.minor += 1;
      continue;
    }
    if (defect.severity !== 'BLOCKER' && defect.severity !== 'MAJOR') continue;

    const problem = defectDowngradeReason(defect, refs.resolved);
    if (problem !== null) {
      downgraded.push(`${defect.id} [${defect.severity}] ${problem}`);
      continue;
    }

    reasons.push(`evaluation:${defect.severity} ${defect.id}`);
    reworkItems.push(
      `${defect.id} [${defect.severity}] ${evidence[0]} — ${redacted(defect.claim)}; ` +
        `сценарий: ${redacted(defect.repro)}`,
    );
    if (defect.severity === 'BLOCKER') counts.blockers += 1;
    else counts.major += 1;
    blocking += 1;
  }

  // Вердикт модели `REWORK` без валидного блокера не блокирует, но фиксируется метрикой.
  if (evaluation.verdict === 'REWORK' && blocking === 0) {
    counts.verdict_without_evidence = 1;
  }

  // Правило 3: есть блокеры → доработка или эскалация по лимиту итераций.
  if (blocking > 0) {
    if (iteration < maxIterations) return finalize('REWORK');
    reasons.push('escalate:iteration_limit');
    return finalize('ESCALATE');
  }

  // Правило 4: что осталось непроверенным. Порядок источников фиксирован.
  for (const gate of gateEntries) {
    if (gate.required !== true || gate.status !== 'not_run') continue;
    unverified.push(
      isText(gate.reason) ? `gate:${gate.id} not_run (${gate.reason})` : `gate:${gate.id} not_run`,
    );
    // `no_database` добором не решается: БД либо есть, либо нет (T9).
    if (gate.reason !== NO_DATABASE) acquire.push(`gate:${gate.id}`);
  }

  if (webDiff && (qaWeb === null || qaWeb.status !== 'done')) {
    const qaReason = qaWeb !== null && isText(qaWeb.reason) ? qaWeb.reason.trim() : 'web-diff';
    unverified.push(`qa-web not_run (${qaReason})`);
    acquire.push('qa-web');
  }

  unverified.push(...criteriaUnverified);
  for (const item of evalUnverified)
    unverified.push(`evaluation unverified: ${redacted(item.what)}`);

  if (unverified.length > 0) {
    if (acquire.length > 0 && retries.evidence < 1) {
      return finalize('ACQUIRE_EVIDENCE', { acquired: acquire });
    }
    return finalize('PROCEED_WITH_UNVERIFIED', { acquired: acquire });
  }

  // Правило 5.
  return finalize('PROCEED');
}

/**
 * Разбирает аргументы командной строки. Любой мусор — ошибка использования (код 2).
 * @param {string[]} argv
 * @returns {{ dir: string|null, iteration: number|null }}
 */
function parseArgs(argv) {
  /** @type {string|null} */
  let dir = null;
  /** @type {number|null} */
  let iteration = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') {
      const value = argv[index + 1];
      if (!isText(value) || value.startsWith('--')) {
        throw new Error('--dir: ожидается путь к каталогу цикла');
      }
      dir = value;
      index += 1;
      continue;
    }
    if (arg === '--iteration') {
      const raw = argv[index + 1];
      const value = typeof raw === 'string' && /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(value)) {
        throw new Error(`--iteration: ожидается целое ≥ 1, получено ${JSON.stringify(raw)}`);
      }
      iteration = value;
      index += 1;
      continue;
    }
    throw new Error(`неизвестный аргумент: ${arg}`);
  }

  return { dir, iteration };
}

/**
 * Читаемое представление артефакта: два пробела и завершающий перевод строки.
 * @param {unknown} data
 * @returns {string}
 */
function serializeArtifact(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/**
 * Читает обязательный JSON-артефакт и проверяет схему. Отсутствие или порча
 * `state.json`/`gates.<n>.json` — отказ (код 2): без них предпосылка DECIDE не выполнена.
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
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: не читается как JSON (${file}): ${reason}`, { cause: error });
  }

  const result = validator(doc);
  if (!result.ok) {
    throw new Error(`${label}: схема нарушена (${file}):\n${result.errors.join('\n')}`);
  }
  return /** @type {Record<string, any>} */ (doc);
}

/**
 * Читает необязательный JSON-артефакт: отсутствие файла — `null`, порча — отказ
 * (повреждённый артефакт супервизора нельзя молча игнорировать).
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
 * Блок ```json из md-вывода агента: `null`, если файла нет, блока нет, JSON битый
 * или схема нарушена. Это вход правила 1, а не отказ CLI.
 * @param {string} file
 * @param {(doc: unknown) => { ok: boolean, errors: string[] }} validator
 * @returns {{ doc: Record<string, any>|null, errors: string[] }}
 */
function readAgentBlock(file, validator) {
  const label = basename(file);
  if (!existsSync(file)) return { doc: null, errors: [`${label}: файл не найден`] };

  /** @type {unknown} */
  let doc;
  try {
    doc = extractLastJsonBlock(readFileSync(file, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      doc: null,
      errors: [`${label}: нет блока \`\`\`json или JSON не разбирается (${message})`],
    };
  }

  const result = validator(doc);
  if (result.ok) return { doc: /** @type {Record<string, any>} */ (doc), errors: [] };
  return { doc: null, errors: result.errors.map((item) => `${label}: ${item}`) };
}

/**
 * Точка входа CLI. Пишет только в каталог цикла; единственный вывод — строка JSON
 * решения в stdout, диагностика — в stderr.
 * @returns {void}
 */
function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const root = repoRoot();
    const dir = args.dir === null ? findActiveCycle() : resolve(args.dir);

    const state = readRequiredJson(join(dir, FIXED_NAMES.state), validateState, 'state.json');
    const iteration = args.iteration ?? state.iteration;
    const names = iterNames(iteration);

    const gates = readRequiredJson(join(dir, names.gates), validateGates, names.gates);
    const reviewBlock = readAgentBlock(join(dir, names.reviewMd), validateReview);
    const evaluationBlock = readAgentBlock(join(dir, names.evaluationMd), validateEvaluation);
    const review = reviewBlock.doc;
    const evaluation = evaluationBlock.doc;
    const qaWeb = readOptionalJson(join(dir, FIXED_NAMES.qaWeb), validateQaWeb, FIXED_NAMES.qaWeb);

    // Web-дифф читается от базы цикла; индекс не меняется (его готовит супервизор).
    const webDiff = diffTouchesWeb(changedFiles(state.base_sha, { cwd: root }));

    // Бюджет (правило 7 §5.6): на момент DECIDE `metrics.json` ещё не написан, поэтому
    // стоимость считается по накопленному `usage.json`. Нет замера — `null`, не ноль.
    const costRub = cycleCostRub({ dir, models: state.models, prices: readPriceSnapshot(root) });

    const agentErrors = {
      [REVIEW_STAGE]: reviewBlock.errors,
      [EVALUATE_STAGE]: evaluationBlock.errors,
    };

    const decision = decide({
      iteration,
      maxIterations: state.max_iterations,
      retries: state.retries,
      gates,
      review,
      evaluation,
      qaWeb,
      webDiff,
      root,
      costRub,
      agentErrors,
    });

    // Полный список ошибок схемы — в stderr (решение говорит только кодом причины, #247).
    for (const message of [...reviewBlock.errors, ...evaluationBlock.errors]) {
      process.stderr.write(`cycle-decide: ${message}\n`);
    }

    // Артефакты из md пишутся только при валидном блоке (D4): иначе оставляем
    // предыдущие файлы нетронутыми, а правило 1 уже отражено в решении.
    if (review !== null) {
      writeJsonAtomic(join(dir, names.reviewJson), normalizeDoc(review), {
        serialize: serializeArtifact,
      });
    }
    if (evaluation !== null) {
      writeJsonAtomic(join(dir, names.evaluationJson), normalizeDoc(evaluation), {
        serialize: serializeArtifact,
      });
    }
    writeJsonAtomic(join(dir, names.decision), normalizeDoc(decision), {
      serialize: serializeArtifact,
    });

    process.stdout.write(`${JSON.stringify(normalizeDoc(decision))}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cycle-decide: ${message}\n`);
    process.exitCode = 2;
  }
}

// Модуль импортируется тестами ради `decide`; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
