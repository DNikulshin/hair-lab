#!/usr/bin/env node
/**
 * Состояние цикла, переходы автомата и блокировка рабочего дерева
 * (docs/orchestrator-core.md §5.3, issue #157, задача T6).
 *
 * Единственный писатель `state.json`. Подкоманды §5.3:
 *
 * ```
 * init     --issue N --slug S --branch B [--date YYYY-MM-DD] [--max-iterations 2] [--dir D]
 * get      [--dir D] [--field F]
 * advance  --to STAGE [--dir D] [--owner-approved]
 * finish   --stage STAGE --status done|error [--detail T] [--dir D]
 * apply-decision [--dir D]
 * escalate --reason R [--detail T] [--dir D]
 * resume   [--dir D]
 * lock     [--dir D] [--slug S] | unlock [--dir D]
 * ```
 *
 * Общий флаг пишущих подкоманд `--now <ISO-8601>` (по умолчанию `new Date().toISOString()`):
 * время приходит только параметром, поэтому два прогона с одним `--now` дают побайтно
 * одинаковые артефакты. `--dir` по умолчанию — единственный активный цикл (`findActiveCycle`);
 * у `init` — `<artifacts>/<date>-<issue>-<slug>`; у `lock`/`unlock` каталог блокировки —
 * `.pi/artifacts/` (или `dirname(--dir)`).
 *
 * Запись состояния — всегда по одному протоколу: чтение → `validateState` → мутация в
 * памяти → `validateState` → `writeJsonAtomic` (pretty 2 + `\n`, как артефакты `cycle-decide`).
 * При любом отказе файл не создаётся и не меняется. Каталог внутри репозитория обязан
 * лежать в `.pi/artifacts/` (`assertWritableDir`, §4); каталог вне репозитория разрешён —
 * так работают тесты на временных git-репозиториях.
 *
 * Коды выхода §4: `0` — успех; `2` — ошибка использования или внутренняя (нет/битый
 * `state.json` или `decision.<n>.json`, мусор в аргументах, опечатка в стадии, неизвестная
 * причина эскалации); `3` — конфликт состояния (недопустимый переход, открытый этап,
 * терминальная стадия, живой lock, повторный `init`). Коды `1` (отрицательный результат
 * гейта) и `4` (`diff_too_large`) этим скриптом не используются: он не запускает проверок.
 *
 * Ключевые решения реализации:
 * - **Итерации.** `iteration` увеличивается ровно на одном ребре — `REWORK → CODE` в
 *   `advance` (уточнение супервизора к плану, §6): `apply-decision` с `REWORK` делает
 *   переход `DECIDE → REWORK` и счётчики не меняет. Иначе первый же `REWORK` упирался бы
 *   в лимит, а инкремент на границе давал бы невалидное состояние (`iteration` >
 *   `max_iterations` без `owner_approved`). На ребре `REWORK → CODE` при
 *   `iteration ≥ max_iterations` нужен `--owner-approved`: с ним `iteration` растёт, а
 *   флаг `owner_approved = true` сохраняется в `state.json` и переживает перезапуски.
 * - **Идемпотентность `apply-decision`.** В `state.json` пишется маркер
 *   `applied_decision: { iteration, action, retry_stage, digest } | null`, где `digest` —
 *   `sha256` (`node:crypto`) от канонического JSON решения (`normalizeDoc` →
 *   `JSON.stringify`). Повторный запуск — no-op с кодом 0 (файл не перезаписывается) только
 *   при совпадении всех четырёх полей, поэтому счётчики `retries` не растут дважды.
 *   Изменённое решение (другая причина эскалации, другие пункты) — новое решение: оно
 *   применяется по общим правилам, а когда переход уже невозможен (этап не DECIDE,
 *   терминальное состояние) — завершается кодом 3, а не молчаливым успехом. Поле вне
 *   Приложения A: валидатор лишние поля игнорирует. `digest` детерминирован, поэтому
 *   артефакты остаются побайтно воспроизводимыми.
 * - **`history[]`.** `advance`/`startStage` дописывают открытую запись
 *   `{ stage, iteration, started_at: now, finished_at: null, status: 'running' }` и ставят
 *   `stage_status = 'running'`; `finish` закрывает последнюю открытую запись
 *   (`finished_at = now`, `status = done|error`, `--detail` → дополнительное поле `detail`).
 *   `init` сразу закрывает INIT как `done`: в протоколе Приложения B у INIT нет `finish`.
 * - **Повторный вход в этап** (после сбоя, §13) — `advance --to <текущий этап>` при
 *   `stage_status = 'error'`; при `running` сначала нужен `finish`.
 * - **Защиты §5.3.** `→ DECIDE` требует `review.<n>.md` и `evaluation.<n>.md` текущей
 *   итерации; `→ PR` — `decision.<n>.json` с `action` `PROCEED` или
 *   `PROCEED_WITH_UNVERIFIED`; `advance --to ESCALATED` запрещён — только `escalate`.
 * - **`escalate`.** `draft_pr_allowed` = проход `code` завершён (`history` содержит запись
 *   `CODE` со `status = 'done'`) ∧ обязательные гейты зелёные (`mandatoryGatesGreen`) ∧
 *   причина ∈ {`iteration_limit`, `budget`, `agent_output_invalid`}. «Зелёные» — fail-safe
 *   (§9 спеки: draft PR только при зелёных обязательных гейтах): `gates.<n>.json` обязан
 *   проходить `validateGates` и относиться к текущей итерации; в нём должен быть хотя бы
 *   один гейт `required: true`; каждый обязательный гейт — `pass` либо `not_run` с причиной
 *   `no_database` (исключение §5.6: БД может отсутствовать). Нет файла, битый документ,
 *   чужая итерация, пустой список гейтов, обязательный `fail`, `skipped` или `not_run` по
 *   другой причине — `false`. Открытая запись закрывается `error` с `detail = reason`, затем
 *   дописывается `ESCALATED` со `status = 'done'`; `escalation.json` получает `open_items`
 *   из `rework_items` + `unverified` решения текущей итерации (нет файла → `[]`).
 * - **`lock`.** Файл `.pi/artifacts/.lock` = `{ pid, slug|null, created_at }`, где `pid` —
 *   родительский процесс (супервизор), а не сам `cycle-state`: короткоживущий процесс
 *   не может держать блокировку. Захват атомарный: эксклюзивное создание
 *   (`openSync(file, 'wx')` + `write` + `close`, без `writeJsonAtomic`) — проверка и запись
 *   не разнесены, поэтому два параллельных `lock` в одном дереве не могут оба получить
 *   код 0. `EEXIST` → осмотр: живой pid → код 3 (два цикла в одном дереве не идут),
 *   пустой файл свежее TTL → тоже код 3 (захват идёт прямо сейчас), мёртвый, битый или
 *   пустой старше `LOCK_EMPTY_TTL_MS` → восстановление.
 *
 *   Восстановление сериализовано файлом `<lock>.takeover` (issue #157, ревью 2): без него
 *   два процесса с мёртвым lock снимали бы его по очереди и второй снёс бы уже свежую
 *   блокировку первого. Под сериализатором состояние перепроверяется, а снятие идёт через
 *   `claimStaleFile` — файл переименовывается и сверяется по inode, поэтому удаления «по пути»
 *   нет. Заброшенный сериализатор
 *   (мёртвый pid или старше `LOCK_TAKEOVER_TTL_MS`) снимается так же. Пустой lock-файл
 *   старше TTL восстанавливается автоматически: иначе сбой между `open` и записью держал бы
 *   дерево до ручного `unlock`. После записи inode открытого
 *   дескриптора сверяется с inode по пути: если файл успели удалить и создать заново,
 *   блокировка чужая — код 3. EPERM при проверке pid трактуется как «жив» (чужой процесс —
 *   не наш случай). `unlock` безусловен: отсутствующий lock — no-op с кодом 0; файл
 *   `<lock>.takeover` при этом не трогается — он живёт только на время восстановления.
 * - **`resume`.** Опирается на актуальную попытку этапа, а не на историческую ошибку:
 *   берётся последняя запись `history` для текущего `state.stage` (записей нет —
 *   `stage_status`). `running` → `continue` с пустым `allowed_next` (сначала `finish`);
 *   `error` → `continue` и `allowed_next: [state.stage]` (повторный вход в тот же этап
 *   разрешён `advance`); `done` → `advance` и цели из таблицы §5.3. Поэтому после
 *   `error` → повторного входа → `finish done` команда снова ведёт вперёд, а не в уже
 *   завершённый этап. Терминальные этапы — код 3.
 * - **Вывод.** Всегда одна строка JSON (`normalizeDoc`, ключи отсортированы): `get` —
 *   состояние (или значение `--field`), изменяющие подкоманды — новое состояние, `resume` —
 *   `{ command, dir, stage, iteration, stage_status, action, allowed_next }`,
 *   `lock` — документ блокировки, `unlock` — `{ command, dir, released }`.
 *   Диагностика — в stderr.
 *
 * `--detail` маскируется `redactLog` (§5.4): телефоны, e-mail и секреты в состояние и
 * `escalation.json` не попадают. ПДн в lock и состоянии нет по составу (pid, slug, пути).
 *
 * Shebang нужен: файл запускается напрямую.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeDoc } from './cycle-decide.mjs';
import { assertWritableDir } from './cycle-evidence.mjs';
import { LIMITS } from './lib/cycle/config.mjs';
import { baseSha as gitBaseSha } from './lib/cycle/git.mjs';
import { readJson, writeJsonAtomic } from './lib/cycle/io.mjs';
import {
  FIXED_NAMES,
  artifactsDir,
  cycleDirName,
  findActiveCycle,
  iterNames,
  repoRoot,
} from './lib/cycle/paths.mjs';
import { redactLog } from './lib/cycle/redact.mjs';
import {
  validateDecision,
  validateEscalation,
  validateGates,
  validateState,
} from './lib/cycle/validate.mjs';

/**
 * Этапы автомата (Приложение A). Копия списка из `validate.mjs` нужна только для разбора
 * аргументов: опечатка в стадии — ошибка использования (код 2), а не конфликт.
 */
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

/** Терминальные этапы: мутации запрещены, `get` и `unlock` работают. */
const TERMINAL_STAGES = Object.freeze(['DONE', 'ESCALATED']);

/** Действия решения, разрешающие переход в PR (§5.3). */
const PROCEED_ACTIONS = Object.freeze(['PROCEED', 'PROCEED_WITH_UNVERIFIED']);

/** Причины эскалации, при которых допустим draft PR (R4, §9 спеки). */
const DRAFT_PR_REASONS = Object.freeze(['iteration_limit', 'budget', 'agent_output_invalid']);

/** Этапы, повторяемые `RETRY_STAGE` (§5.6, правило 1). */
const RETRY_STAGES = Object.freeze(['REVIEW', 'EVALUATE']);

/** Имя файла блокировки рабочего дерева. */
const LOCK_NAME = '.lock';

/**
 * Суффикс файла-сериализатора восстановления. Снимать устаревший lock можно только одному
 * процессу: иначе второй снимет уже свежую блокировку первого (issue #157, ревью 2).
 */
const LOCK_TAKEOVER_SUFFIX = '.takeover';

/**
 * Сколько ждать, прежде чем считать пустой lock-файл заброшенным, мс. Пустой файл означает
 * «между открытием и записью»: свежий — активный захват (код 3), старше TTL — сбой процесса,
 * и такой файл восстанавливается автоматически, иначе дерево заклинивает до ручного `unlock`.
 */
const LOCK_EMPTY_TTL_MS = 30_000;

/** Сколько ждать, прежде чем считать файл-сериализатор заброшенным, мс. */
const LOCK_TAKEOVER_TTL_MS = 30_000;

/** Агенты, чьи модели попадают в `state.models` при `init` (H1: `evaluate` появится в T7). */
const MODEL_AGENTS = Object.freeze(['plan', 'code', 'review', 'evaluate']);

/** Подкоманды §5.3. */
const COMMANDS = Object.freeze([
  'init',
  'get',
  'advance',
  'finish',
  'apply-decision',
  'escalate',
  'resume',
  'lock',
  'unlock',
]);

/** Флаги, допустимые для каждой подкоманды: остальные — ошибка использования. */
const COMMAND_OPTIONS = Object.freeze({
  init: Object.freeze([
    '--issue',
    '--slug',
    '--branch',
    '--date',
    '--max-iterations',
    '--dir',
    '--now',
  ]),
  get: Object.freeze(['--dir', '--field']),
  advance: Object.freeze(['--to', '--dir', '--owner-approved', '--now']),
  finish: Object.freeze(['--stage', '--status', '--detail', '--dir', '--now']),
  'apply-decision': Object.freeze(['--dir', '--now']),
  escalate: Object.freeze(['--reason', '--detail', '--dir', '--now']),
  resume: Object.freeze(['--dir']),
  lock: Object.freeze(['--dir', '--slug', '--now']),
  unlock: Object.freeze(['--dir']),
});

/** ISO-8601 со временем и зоной: та же форма, что требует валидатор `state.started_at`. */
const ISO_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Дата каталога цикла, `YYYY-MM-DD` (`paths.cycleDirName`). */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Slug задачи — как в схеме `state.slug`. */
const SLUG = /^[a-z0-9-]{1,60}$/;

/** Целое ≥ 1 в текстовом виде (`--issue`, `--max-iterations`). */
const POSITIVE_INT = /^[1-9]\d*$/;

/** Ошибка использования или внутренняя: код 2. */
export class UsageError extends Error {}

/** Конфликт состояния: код 3. */
export class ConflictError extends Error {}

/**
 * Таблица допустимых переходов §5.3. `DONE` и `ESCALATED` терминальны — ключей нет.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const TRANSITIONS = Object.freeze({
  INIT: Object.freeze(['PLAN', 'ESCALATED']),
  PLAN: Object.freeze(['CODE', 'ESCALATED']),
  CODE: Object.freeze(['GATES']),
  GATES: Object.freeze(['QA_WEB', 'REVIEW', 'ESCALATED']),
  QA_WEB: Object.freeze(['REVIEW']),
  REVIEW: Object.freeze(['EVALUATE', 'DECIDE']),
  EVALUATE: Object.freeze(['REVIEW', 'DECIDE']),
  DECIDE: Object.freeze(['REWORK', 'ACQUIRE_EVIDENCE', 'REVIEW', 'EVALUATE', 'PR', 'ESCALATED']),
  REWORK: Object.freeze(['CODE']),
  ACQUIRE_EVIDENCE: Object.freeze(['GATES', 'QA_WEB']),
  PR: Object.freeze(['DONE']),
});

/**
 * Разрешён ли переход по таблице §5.3 (включая переходы в `ESCALATED`).
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  const targets = TRANSITIONS[from];
  return Array.isArray(targets) && targets.includes(to);
}

/**
 * Цели `advance` из этапа: таблица без `ESCALATED` — эскалация только подкомандой
 * `escalate` (у неё свои защиты и `escalation.json`).
 * @param {string} from
 * @returns {string[]}
 */
export function advanceTargets(from) {
  return (TRANSITIONS[from] ?? []).filter((stage) => stage !== 'ESCALATED');
}

/**
 * Терминальный этап: мутации запрещены (код 3).
 * @param {{ stage: string }} state
 * @returns {void}
 */
function assertNotTerminal(state) {
  if (TERMINAL_STAGES.includes(state.stage)) {
    throw new ConflictError(
      `цикл завершён (stage = ${state.stage}): изменение состояния недопустимо (§5.3)`,
    );
  }
}

/**
 * Начало этапа: открытая запись в `history[]` и `stage_status = 'running'`.
 * Чистая функция — время приходит параметром `now`.
 * @param {Record<string, any>} state проверенное состояние
 * @param {{ stage: string, iteration?: number, now: string }} options
 * @returns {Record<string, any>} новое состояние
 */
export function startStage(state, { stage, iteration = state.iteration, now }) {
  return {
    ...state,
    stage,
    stage_status: 'running',
    history: [
      ...state.history,
      { stage, iteration, started_at: now, finished_at: null, status: 'running' },
    ],
    updated_at: now,
  };
}

/**
 * Переход `advance --to STAGE` с защитами §5.3. Возвращает новое состояние или бросает
 * `ConflictError` (код 3); файл не меняется, вызывающий пишет только после валидации.
 * @param {Record<string, any>} state проверенное состояние
 * @param {{
 *   to: string,
 *   now: string,
 *   ownerApproved?: boolean,
 *   artifacts?: { hasReview?: boolean, hasEvaluation?: boolean, decision?: Record<string, any>|null },
 * }} options
 *   `artifacts` — предусловия этапа, собранные вызывающим из каталога цикла: наличие
 *   `review.<n>.md`/`evaluation.<n>.md` для `→ DECIDE` и решение с `PROCEED*` для `→ PR`.
 * @returns {Record<string, any>} новое состояние
 */
export function advanceTo(state, { to, now, ownerApproved = false, artifacts = {} }) {
  assertNotTerminal(state);

  if (to === 'ESCALATED') {
    throw new ConflictError('переход в ESCALATED выполняется подкомандой escalate (§5.3)');
  }

  if (to === state.stage) {
    // Повторный вход в текущий этап — только после сбоя (§13): иначе сначала finish.
    if (state.stage_status !== 'error') {
      throw new ConflictError(
        `этап ${to} уже текущий (stage_status = ${state.stage_status}): повторный вход ` +
          `возможен только при stage_status = 'error'`,
      );
    }
  } else {
    if (state.stage_status === 'running') {
      throw new ConflictError(
        `этап ${state.stage} открыт (stage_status = 'running'): сначала finish (§5.3)`,
      );
    }
    if (!canTransition(state.stage, to)) {
      throw new ConflictError(`переход ${state.stage} → ${to} недопустим (таблица §5.3)`);
    }
  }

  if (to === 'DECIDE' && !(artifacts.hasReview === true && artifacts.hasEvaluation === true)) {
    throw new ConflictError(
      `переход ${state.stage} → DECIDE требует review.<n>.md и evaluation.<n>.md текущей итерации (§5.3)`,
    );
  }

  if (to === 'PR' && !PROCEED_ACTIONS.includes(artifacts.decision?.action)) {
    throw new ConflictError(
      'переход в PR требует decision.<n>.json с action PROCEED или PROCEED_WITH_UNVERIFIED (§5.3)',
    );
  }

  /** @type {Record<string, any>} */
  let base = state;
  if (state.stage === 'REWORK' && to === 'CODE') {
    if (state.iteration >= state.max_iterations && !ownerApproved) {
      throw new ConflictError(
        `REWORK → CODE: iteration ${state.iteration} ≥ max_iterations ${state.max_iterations}, ` +
          'без --owner-approved переход отклонён (§5.3)',
      );
    }
    base = {
      ...state,
      iteration: state.iteration + 1,
      owner_approved: ownerApproved ? true : state.owner_approved,
    };
  }

  return startStage(base, { stage: to, iteration: base.iteration, now });
}

/**
 * Закрытие этапа `finish --stage STAGE --status done|error`.
 * @param {Record<string, any>} state проверенное состояние
 * @param {{ stage: string, status: 'done'|'error', detail?: string|null, now: string }} options
 * @returns {Record<string, any>} новое состояние
 */
export function finishStage(state, { stage, status, detail = null, now }) {
  assertNotTerminal(state);

  if (!STAGES.includes(stage)) {
    throw new UsageError(`--stage: ожидается этап автомата, получено ${JSON.stringify(stage)}`);
  }
  if (state.stage !== stage) {
    throw new ConflictError(
      `текущий этап ${state.stage}, а закрывается ${stage}: finish не совпадает с состоянием (§5.3)`,
    );
  }

  const last = state.history.at(-1);
  if (last === undefined || last.finished_at !== null || last.status !== 'running') {
    throw new ConflictError(`нет открытой записи этапа ${stage}: закрывать нечего (§5.3)`);
  }

  /** @type {Record<string, any>} */
  const entry = { ...last, finished_at: now, status };
  if (detail !== null) entry.detail = redactLog(detail);

  return {
    ...state,
    stage_status: status,
    history: [...state.history.slice(0, -1), entry],
    updated_at: now,
  };
}

/**
 * Начальное состояние цикла (`init`). INIT сразу закрыт как `done`: в протоколе
 * Приложения B у INIT нет `finish`.
 * @param {{
 *   issue: number,
 *   slug: string,
 *   branch: string,
 *   baseSha: string,
 *   models: Record<string, string>,
 *   now: string,
 *   maxIterations?: number,
 * }} options
 * @returns {Record<string, any>}
 */
export function buildInitState({
  issue,
  slug,
  branch,
  baseSha,
  models,
  now,
  maxIterations = LIMITS.defaultMaxIterations,
}) {
  return {
    issue,
    slug,
    branch,
    base_sha: baseSha,
    iteration: 1,
    max_iterations: maxIterations,
    stage: 'INIT',
    stage_status: 'done',
    criteria_source: 'issue',
    retries: { REVIEW: 0, EVALUATE: 0, evidence: 0 },
    owner_approved: false,
    models,
    history: [{ stage: 'INIT', iteration: 1, started_at: now, finished_at: now, status: 'done' }],
    escalation: null,
    applied_decision: null,
    started_at: now,
    updated_at: now,
  };
}

/**
 * `sha256` канонического JSON решения: `normalizeDoc` сортирует ключи, поэтому digest
 * не зависит от порядка полей в `decision.<n>.json` и файл остаётся побайтно
 * воспроизводимым.
 * @param {Record<string, any>} decision проверенное решение
 * @returns {string} hex-дайджест
 */
export function decisionDigest(decision) {
  return createHash('sha256')
    .update(JSON.stringify(normalizeDoc(decision)))
    .digest('hex');
}

/**
 * Маркер применённого решения (`applied_decision`). Сравнивается по четырём полям:
 * `iteration`, `action`, `retry_stage` и `digest` (содержимое решения целиком). Повторный
 * запуск `apply-decision` с тем же решением — no-op, с изменённым — применяется заново.
 * @param {Record<string, any>} decision проверенное решение
 * @returns {{ iteration: number, action: string, retry_stage: string|null, digest: string }}
 */
export function decisionMarker(decision) {
  return {
    iteration: decision.iteration,
    action: decision.action,
    retry_stage: decision.retry_stage ?? null,
    digest: decisionDigest(decision),
  };
}

/**
 * Совпадает ли записанный маркер с текущим решением (идемпотентность `apply-decision`).
 * Нет `digest` (старый маркер) — не совпадает: решение применяется заново.
 * @param {unknown} applied значение `state.applied_decision`
 * @param {{ iteration: number, action: string, retry_stage: string|null, digest: string }} marker
 * @returns {boolean}
 */
export function markerMatches(applied, marker) {
  if (applied === null || typeof applied !== 'object') return false;
  const doc = /** @type {Record<string, any>} */ (applied);
  return (
    doc.iteration === marker.iteration &&
    doc.action === marker.action &&
    (doc.retry_stage ?? null) === marker.retry_stage &&
    doc.digest === marker.digest
  );
}

/**
 * Применение решения `decision.<n>.json` к состоянию (`apply-decision`).
 *
 * Счётчики: `RETRY_STAGE` → `retries[stage]++`, `ACQUIRE_EVIDENCE` → `retries.evidence++`,
 * `REWORK` → переход в REWORK без изменения `iteration` (инкремент — на ребре
 * `REWORK → CODE`, уточнение супервизора §6), `PROCEED*` → PR, `ESCALATE` → `escalate`.
 * @param {Record<string, any>} state проверенное состояние
 * @param {{
 *   decision: Record<string, any>,
 *   now: string,
 *   escalation?: Record<string, any>|null,
 * }} options `escalation` — документ эскалации для action = ESCALATE
 * @returns {Record<string, any>} новое состояние
 */
export function applyDecisionToState(state, { decision, now, escalation = null }) {
  assertNotTerminal(state);

  if (state.stage !== 'DECIDE') {
    throw new ConflictError(
      `apply-decision возможен только из DECIDE, текущий этап ${state.stage} (§5.3)`,
    );
  }
  if (decision.iteration !== state.iteration) {
    throw new ConflictError(
      `решение для итерации ${decision.iteration}, а в состоянии ${state.iteration} (§5.3)`,
    );
  }

  switch (decision.action) {
    case 'REWORK':
      return startStage(state, { stage: 'REWORK', now });
    case 'ACQUIRE_EVIDENCE':
      return startStage(
        {
          ...state,
          retries: { ...state.retries, evidence: state.retries.evidence + 1 },
        },
        { stage: 'ACQUIRE_EVIDENCE', now },
      );
    case 'RETRY_STAGE': {
      const stage = decision.retry_stage;
      if (!RETRY_STAGES.includes(stage)) {
        throw new ConflictError(`RETRY_STAGE: недопустимый этап ${JSON.stringify(stage)} (§5.6)`);
      }
      return startStage(
        { ...state, retries: { ...state.retries, [stage]: state.retries[stage] + 1 } },
        { stage, now },
      );
    }
    case 'PROCEED':
    case 'PROCEED_WITH_UNVERIFIED':
      return startStage(state, { stage: 'PR', now });
    case 'ESCALATE': {
      if (escalation === null) {
        throw new UsageError('apply-decision: для ESCALATE нужен escalation.json');
      }
      return escalateToState(state, { escalation, now });
    }
    default:
      throw new ConflictError(
        `действие ${JSON.stringify(decision.action)} не применимо к состоянию (§5.3)`,
      );
  }
}

/**
 * Закрывает последнюю открытую запись `history[]`, не трогая остальные.
 * @param {Record<string, any>[]} history
 * @param {{ status: 'done'|'error', detail?: string|null, now: string }} options
 * @returns {Record<string, any>[]}
 */
function closeOpenRecord(history, { status, detail = null, now }) {
  let index = -1;
  for (let position = history.length - 1; position >= 0; position -= 1) {
    if (history[position].finished_at === null) {
      index = position;
      break;
    }
  }
  if (index === -1) return [...history];

  /** @type {Record<string, any>} */
  const entry = { ...history[index], finished_at: now, status };
  if (detail !== null) entry.detail = detail;

  const closed = [...history];
  closed[index] = entry;
  return closed;
}

/**
 * Завершён ли проход `code`: последняя запись `history` со `stage = CODE` имеет `done`.
 * @param {Record<string, any>[]} history
 * @returns {boolean}
 */
export function codePassDone(history) {
  for (let position = history.length - 1; position >= 0; position -= 1) {
    if (history[position].stage === 'CODE') return history[position].status === 'done';
  }
  return false;
}

/**
 * Зелёный ли обязательный гейт (§5.5, §9): `pass` или `not_run` с причиной `no_database`
 * (исключение §5.6: БД может отсутствовать). `skipped` и `not_run` по любой другой причине
 * — не зелёный: данных для draft PR не хватает.
 * @param {Record<string, any>} gate запись `gates[]`
 * @returns {boolean}
 */
function gateGreen(gate) {
  if (gate.status === 'pass') return true;
  return gate.status === 'not_run' && gate.reason === 'no_database';
}

/**
 * Все ли обязательные гейты зелёные (условие draft PR, §9 спеки). Fail-safe: невалидный
 * документ, чужая/неизвестная итерация и отсутствие обязательных гейтов — `false`
 * (неполные данные — не повод открывать draft PR).
 * @param {unknown} gatesDoc разобранный `gates.<n>.json` или `null`
 * @param {number} iteration итерация состояния: документ обязан относиться к ней
 * @returns {boolean}
 */
export function mandatoryGatesGreen(gatesDoc, iteration) {
  if (gatesDoc === null || typeof gatesDoc !== 'object') return false;
  if (!validateGates(gatesDoc).ok) return false;
  const doc = /** @type {{ iteration: number, gates: Record<string, any>[] }} */ (gatesDoc);
  if (doc.iteration !== iteration) return false;

  const required = doc.gates.filter((gate) => gate.required === true);
  if (required.length === 0) return false;
  return required.every(gateGreen);
}

/**
 * Условие draft PR (§5.3, R4, §9 спеки): проход `code` завершён, обязательные гейты
 * зелёные (`mandatoryGatesGreen`) и причина из списка
 * `iteration_limit`/`budget`/`agent_output_invalid`.
 * @param {{ reason: string, codePassDone: boolean, gatesOk: boolean }} options
 * @returns {boolean}
 */
export function draftPrAllowed({ reason, codePassDone: passDone, gatesOk }) {
  return DRAFT_PR_REASONS.includes(reason) && passDone === true && gatesOk === true;
}

/**
 * Документ `escalation.json` (Приложение A). `detail` маскируется (§5.4), `open_items`
 * приходят из решения текущей итерации.
 * @param {{
 *   reason: string,
 *   detail?: string|null,
 *   codePassDone?: boolean,
 *   gatesOk?: boolean,
 *   openItems?: string[],
 * }} options
 * @returns {Record<string, any>}
 */
export function buildEscalation({
  reason,
  detail = null,
  codePassDone: passDone = false,
  gatesOk = false,
  openItems = [],
}) {
  return {
    reason,
    detail: detail === null ? null : redactLog(detail),
    draft_pr_allowed: draftPrAllowed({ reason, codePassDone: passDone, gatesOk }),
    open_items: [...openItems],
  };
}

/**
 * Проверяет причину эскалации по словарю D7 через валидатор `escalation.json` — списка
 * причин в этом модуле нет, источник истины один (`validate.mjs`).
 * @param {unknown} reason
 * @returns {boolean}
 */
export function isValidEscalationReason(reason) {
  if (typeof reason !== 'string') return false;
  return validateEscalation({
    reason,
    detail: null,
    draft_pr_allowed: false,
    open_items: [],
  }).ok;
}

/**
 * Причина эскалации из решения (`reasons[]` вида `escalate:<reason>`, §5.6). Неизвестная
 * причина — `internal_error`: эскалация не должна терять факт блокировки.
 * @param {Record<string, any>} decision
 * @returns {string}
 */
export function escalationReasonFromDecision(decision) {
  const reasons = Array.isArray(decision.reasons) ? decision.reasons : [];
  for (const item of reasons) {
    if (typeof item !== 'string' || !item.startsWith('escalate:')) continue;
    const reason = item.slice('escalate:'.length);
    if (isValidEscalationReason(reason)) return reason;
  }
  return 'internal_error';
}

/**
 * Переход в ESCALATED (`escalate` и `apply-decision` с ESCALATE): открытая запись
 * закрывается `error`, документ эскалации пишется вызывающим.
 * @param {Record<string, any>} state проверенное состояние
 * @param {{ escalation: Record<string, any>, now: string }} options
 * @returns {Record<string, any>} новое состояние
 */
export function escalateToState(state, { escalation, now }) {
  assertNotTerminal(state);
  if (!canTransition(state.stage, 'ESCALATED')) {
    throw new ConflictError(`эскалация из ${state.stage} недопустима (таблица §5.3)`);
  }

  return {
    ...state,
    stage: 'ESCALATED',
    stage_status: 'done',
    escalation: {
      reason: escalation.reason,
      detail: escalation.detail,
      draft_pr_allowed: escalation.draft_pr_allowed,
    },
    history: [
      ...closeOpenRecord(state.history, {
        status: 'error',
        detail: escalation.reason,
        now,
      }),
      {
        stage: 'ESCALATED',
        iteration: state.iteration,
        started_at: now,
        finished_at: now,
        status: 'done',
      },
    ],
    updated_at: now,
  };
}

/**
 * Куда возобновлять цикл (`resume`, §13). Смотрим актуальную попытку текущего этапа —
 * последнюю запись `history` с `stage = state.stage` (записей нет — `stage_status`), — а не
 * первую незакрытую запись: иначе старая `error` после успешного повторного прохода
 * возвращала бы `continue` для уже завершённого этапа.
 *
 * - `running` → `continue`, `allowed_next: []` (сначала `finish`);
 * - `error` → `continue`, `allowed_next: [state.stage]` (повторный вход в тот же этап
 *   разрешён `advance`);
 * - `done` → `advance` и цели из таблицы §5.3.
 *
 * Терминальные этапы — код 3.
 * @param {Record<string, any>} state проверенное состояние
 * @returns {{ action: 'continue'|'advance', allowed_next: string[] }}
 */
export function resumeTarget(state) {
  assertNotTerminal(state);

  let current = null;
  for (let position = state.history.length - 1; position >= 0; position -= 1) {
    if (state.history[position].stage === state.stage) {
      current = state.history[position];
      break;
    }
  }
  const status = current === null ? state.stage_status : current.status;

  if (status === 'running') return { action: 'continue', allowed_next: [] };
  if (status === 'error') return { action: 'continue', allowed_next: [state.stage] };
  return { action: 'advance', allowed_next: advanceTargets(state.stage) };
}

/**
 * Разбирает аргументы командной строки. Неизвестная подкоманда, чужой флаг, отсутствующее
 * значение и мусор в типизированных флагах — ошибка использования (код 2).
 * @param {string[]} argv аргументы без `node` и имени скрипта
 * @returns {{
 *   command: string,
 *   dir: string|null,
 *   field: string|null,
 *   to: string|null,
 *   stage: string|null,
 *   status: 'done'|'error'|null,
 *   detail: string|null,
 *   reason: string|null,
 *   issue: number|null,
 *   slug: string|null,
 *   branch: string|null,
 *   date: string|null,
 *   maxIterations: number|null,
 *   ownerApproved: boolean,
 *   now: string|null,
 * }}
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === undefined) {
    throw new UsageError(`не задана подкоманда: ${COMMANDS.join(' | ')}`);
  }
  if (!COMMANDS.includes(command)) {
    throw new UsageError(`неизвестная подкоманда: ${command} (ожидается ${COMMANDS.join(' | ')})`);
  }

  const allowed = COMMAND_OPTIONS[command];
  /** @type {Record<string, string>} */
  const raw = {};

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) {
      throw new UsageError(`${command}: лишний аргумент ${JSON.stringify(arg)}`);
    }
    if (!allowed.includes(arg)) {
      throw new UsageError(`${command}: флаг ${arg} не поддерживается (${allowed.join(', ')})`);
    }
    if (arg === '--owner-approved') {
      raw['owner-approved'] = 'true';
      continue;
    }
    const value = rest[index + 1];
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
      throw new UsageError(`${arg}: ожидается значение`);
    }
    raw[arg.slice(2)] = value;
    index += 1;
  }

  return {
    command,
    dir: raw.dir ?? null,
    field: raw.field ?? null,
    to: parseStage(raw.to, '--to'),
    stage: parseStage(raw.stage, '--stage'),
    status: parseStatus(raw.status),
    detail: raw.detail ?? null,
    reason: raw.reason ?? null,
    issue: parsePositiveInt(raw.issue, '--issue'),
    slug: parseSlug(raw.slug),
    branch: parseBranch(raw.branch),
    date: parseDate(raw.date),
    maxIterations: parsePositiveInt(raw['max-iterations'], '--max-iterations'),
    ownerApproved: raw['owner-approved'] === 'true',
    now: parseNow(raw.now),
  };
}

/**
 * Этап автомата из аргумента: опечатка — ошибка использования, а не конфликт.
 * @param {string|undefined} value
 * @param {string} label
 * @returns {string|null}
 */
function parseStage(value, label) {
  if (value === undefined) return null;
  if (!STAGES.includes(value)) {
    throw new UsageError(
      `${label}: неизвестный этап ${JSON.stringify(value)} (${STAGES.join('|')})`,
    );
  }
  return value;
}

/**
 * Статус завершения этапа: только `done` или `error` (§5.3).
 * @param {string|undefined} value
 * @returns {'done'|'error'|null}
 */
function parseStatus(value) {
  if (value === undefined) return null;
  if (value !== 'done' && value !== 'error') {
    throw new UsageError(`--status: ожидается done|error, получено ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Целое ≥ 1 из аргумента.
 * @param {string|undefined} value
 * @param {string} label
 * @returns {number|null}
 */
function parsePositiveInt(value, label) {
  if (value === undefined) return null;
  if (!POSITIVE_INT.test(value)) {
    throw new UsageError(`${label}: ожидается целое ≥ 1, получено ${JSON.stringify(value)}`);
  }
  return Number(value);
}

/**
 * Slug задачи по шаблону схемы состояния.
 * @param {string|undefined} value
 * @returns {string|null}
 */
function parseSlug(value) {
  if (value === undefined) return null;
  if (!SLUG.test(value)) {
    throw new UsageError(`--slug: ожидается ^[a-z0-9-]{1,60}$, получено ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Имя ветки. Проверяется только непустота и отсутствие ведущего дефиса: git-ссылки
 * с пробелами всё равно не пройдут проверку в `git.mjs` при вычислении `base_sha`.
 * @param {string|undefined} value
 * @returns {string|null}
 */
function parseBranch(value) {
  if (value === undefined) return null;
  if (value.trim() === '' || value.startsWith('-')) {
    throw new UsageError(`--branch: ожидается имя ветки, получено ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Дата каталога цикла, `YYYY-MM-DD`.
 * @param {string|undefined} value
 * @returns {string|null}
 */
function parseDate(value) {
  if (value === undefined) return null;
  if (!DATE.test(value)) {
    throw new UsageError(`--date: ожидается YYYY-MM-DD, получено ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Момент времени `--now`: форма ISO-8601 со временем и зоной (как в схеме состояния).
 * @param {string|undefined} value
 * @returns {string|null}
 */
function parseNow(value) {
  if (value === undefined) return null;
  if (!ISO_NOW.test(value)) {
    throw new UsageError(`--now: ожидается ISO-8601 со временем и зоной, получено ${value}`);
  }
  return value;
}

/**
 * Момент времени команды: флаг `--now` или текущее время (тесты всегда передают флаг).
 * @param {{ now: string|null }} args
 * @returns {string}
 */
function resolveNow(args) {
  return args.now ?? new Date().toISOString();
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
 * Одна строка JSON в stdout: ключи отсортированы (`normalizeDoc`), поэтому вывод
 * детерминирован.
 * @param {unknown} value
 * @returns {void}
 */
function printJson(value) {
  process.stdout.write(`${JSON.stringify(normalizeDoc(value))}\n`);
}

/**
 * Каталог цикла для подкоманд: явный `--dir` или единственный активный цикл.
 * @param {{ dir: string|null }} args
 * @returns {string}
 */
function cycleDir(args) {
  return args.dir === null ? findActiveCycle() : resolve(args.dir);
}

/**
 * Читает `state.json` и проверяет схему. Нет файла или порча — код 2: без достоверного
 * состояния переходы не разрешаются, файл не перезаписывается.
 * @param {string} file
 * @returns {Record<string, any>}
 */
function readState(file) {
  /** @type {unknown} */
  let doc;
  try {
    doc = readJson(file);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${FIXED_NAMES.state}: не читается (${file}): ${reason}`, {
      cause: error,
    });
  }

  const result = validateState(doc);
  if (!result.ok) {
    throw new UsageError(
      `${FIXED_NAMES.state}: схема нарушена (${file}):\n${result.errors.join('\n')}`,
    );
  }
  return /** @type {Record<string, any>} */ (doc);
}

/**
 * Записывает состояние: проверка схемы до записи (мутация не должна уронить файл) и
 * атомарная запись с сортировкой ключей.
 * @param {string} file
 * @param {Record<string, any>} state
 * @returns {void}
 */
function writeState(file, state) {
  const result = validateState(state);
  if (!result.ok) {
    throw new UsageError(
      `${FIXED_NAMES.state}: результат мутации не проходит схему:\n${result.errors.join('\n')}`,
    );
  }
  writeJsonAtomic(file, normalizeDoc(state), { serialize: serializeArtifact });
}

/**
 * Решение текущей итерации, если оно есть, валидно и относится к этой итерации.
 * Для `→ PR` этого достаточно: битый или чужой файл означает «решения нет» (код 3).
 * @param {string} file
 * @param {number} iteration
 * @returns {Record<string, any>|null}
 */
function readDecisionArtifact(file, iteration) {
  if (!existsSync(file)) return null;

  /** @type {unknown} */
  let doc;
  try {
    doc = readJson(file);
  } catch {
    return null;
  }
  if (!validateDecision(doc).ok) return null;
  const decision = /** @type {Record<string, any>} */ (doc);
  return decision.iteration === iteration ? decision : null;
}

/**
 * Решение для `apply-decision`: отсутствие или порча — код 2 (применять нечего),
 * чужая итерация — код 3 (решение не про это состояние).
 * @param {string} file
 * @param {number} iteration
 * @returns {Record<string, any>}
 */
function readDecisionRequired(file, iteration) {
  /** @type {unknown} */
  let doc;
  try {
    doc = readJson(file);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`decision: не читается (${file}): ${reason}`, { cause: error });
  }

  const result = validateDecision(doc);
  if (!result.ok) {
    throw new UsageError(`decision: схема нарушена (${file}):\n${result.errors.join('\n')}`);
  }
  const decision = /** @type {Record<string, any>} */ (doc);
  if (decision.iteration !== iteration) {
    throw new ConflictError(
      `решение для итерации ${decision.iteration}, а в состоянии ${iteration} (§5.3)`,
    );
  }
  return decision;
}

/**
 * Элементы, остающиеся открытыми, из решения текущей итерации (§5.3: `open_items`).
 * Нет файла или он битый — пустой список.
 * @param {string} file
 * @returns {string[]}
 */
function openItemsFrom(file) {
  if (!existsSync(file)) return [];

  /** @type {unknown} */
  let doc;
  try {
    doc = readJson(file);
  } catch {
    return [];
  }
  if (typeof doc !== 'object' || doc === null) return [];

  const decision = /** @type {Record<string, any>} */ (doc);
  /** @type {string[]} */
  const items = [];
  for (const key of ['rework_items', 'unverified']) {
    const list = Array.isArray(decision[key]) ? decision[key] : [];
    for (const item of list) if (typeof item === 'string') items.push(item);
  }
  return items;
}

/**
 * Окружение эскалации: завершённость прохода `code`, зелёные обязательные гейты и открытые
 * пункты решения текущей итерации.
 * @param {string} dir каталог цикла
 * @param {Record<string, any>} state проверенное состояние
 * @returns {{ codePassDone: boolean, gatesOk: boolean, openItems: string[] }}
 */
function escalationEnv(dir, state) {
  const names = iterNames(state.iteration);

  /** @type {unknown} */
  let gatesDoc = null;
  const gatesFile = join(dir, names.gates);
  if (existsSync(gatesFile)) {
    try {
      gatesDoc = readJson(gatesFile);
    } catch {
      gatesDoc = null;
    }
  }

  return {
    codePassDone: codePassDone(state.history),
    gatesOk: mandatoryGatesGreen(gatesDoc, state.iteration),
    openItems: openItemsFrom(join(dir, names.decision)),
  };
}

/**
 * Значение `model:` из frontmatter агента (`.pi/agents/*.md`): блок между первыми `---`,
 * строки `key: value`, значения в кавычках допустимы (как в `check-harness` H1).
 * @param {string} text
 * @param {string} key
 * @returns {string|null}
 */
function frontmatterValue(text, key) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return null;

  for (const line of match[1].split(/\r?\n/)) {
    const parsed = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (parsed === null || parsed[1] !== key) continue;
    const value = parsed[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value !== '') return value;
  }
  return null;
}

/**
 * Модели агентов для `state.models`: единственный источник — `.pi/agents/*.md` (AGENTS.md
 * имён моделей не содержит, T7 их оттуда убирает). Нет файла (до T7 — `evaluate`) — ключ
 * опускается.
 * @param {string} root корень репозитория
 * @returns {Record<string, string>}
 */
function readModels(root) {
  /** @type {Record<string, string>} */
  const models = {};
  for (const agent of MODEL_AGENTS) {
    const file = join(root, '.pi', 'agents', `${agent}.md`);
    if (!existsSync(file)) continue;
    const model = frontmatterValue(readFileSync(file, 'utf8'), 'model');
    if (model !== null) models[agent] = model;
  }
  return models;
}

/**
 * Проверяет документ эскалации перед записью (словарь причин D7 и обязательные поля).
 * @param {Record<string, any>} escalation
 * @returns {void}
 */
function assertValidEscalation(escalation) {
  const result = validateEscalation(escalation);
  if (!result.ok) {
    throw new UsageError(`escalation.json: схема нарушена:\n${result.errors.join('\n')}`);
  }
}

/**
 * `init`: каталог цикла и `state.json`. Повторный `init` в тот же каталог — код 3.
 * @param {ReturnType<typeof parseArgs>} args
 * @param {string} root
 * @returns {number} код выхода
 */
function runInit(args, root) {
  if (args.issue === null || args.slug === null || args.branch === null) {
    throw new UsageError('init: обязательны --issue, --slug и --branch');
  }

  const now = resolveNow(args);
  const date = args.date ?? now.slice(0, 10);
  const dir =
    args.dir === null
      ? join(artifactsDir(root), cycleDirName({ date, issue: args.issue, slug: args.slug }))
      : resolve(args.dir);
  assertWritableDir(dir, root);

  const file = join(dir, FIXED_NAMES.state);
  if (existsSync(file)) {
    throw new ConflictError(`цикл уже инициализирован: ${file} (повторный init запрещён)`);
  }

  const state = buildInitState({
    issue: args.issue,
    slug: args.slug,
    branch: args.branch,
    baseSha: gitBaseSha({ branch: 'main', cwd: root }),
    models: readModels(root),
    now,
    maxIterations: args.maxIterations ?? LIMITS.defaultMaxIterations,
  });

  mkdirSync(dir, { recursive: true });
  writeState(file, state);
  printJson(state);
  return 0;
}

/**
 * `get`: состояние целиком или значение поля. Работает и на терминальных этапах.
 * @param {ReturnType<typeof parseArgs>} args
 * @returns {number} код выхода
 */
function runGet(args) {
  const state = readState(join(cycleDir(args), FIXED_NAMES.state));

  if (args.field === null) {
    printJson(state);
    return 0;
  }
  if (!Object.hasOwn(state, args.field)) {
    throw new UsageError(`--field: в state.json нет поля ${JSON.stringify(args.field)}`);
  }
  printJson(state[args.field]);
  return 0;
}

/**
 * `advance --to STAGE`: переход по таблице §5.3 с защитами.
 * @param {ReturnType<typeof parseArgs>} args
 * @param {string} root
 * @returns {number} код выхода
 */
function runAdvance(args, root) {
  if (args.to === null) throw new UsageError('advance: обязателен --to STAGE');

  const dir = cycleDir(args);
  assertWritableDir(dir, root);
  const file = join(dir, FIXED_NAMES.state);
  const state = readState(file);
  const now = resolveNow(args);
  const names = iterNames(state.iteration);

  const next = advanceTo(state, {
    to: args.to,
    now,
    ownerApproved: args.ownerApproved,
    artifacts: {
      hasReview: existsSync(join(dir, names.reviewMd)),
      hasEvaluation: existsSync(join(dir, names.evaluationMd)),
      decision: readDecisionArtifact(join(dir, names.decision), state.iteration),
    },
  });

  writeState(file, next);
  printJson(next);
  return 0;
}

/**
 * `finish --stage STAGE --status done|error [--detail T]`: закрывает открытую запись этапа.
 * @param {ReturnType<typeof parseArgs>} args
 * @param {string} root
 * @returns {number} код выхода
 */
function runFinish(args, root) {
  if (args.stage === null || args.status === null) {
    throw new UsageError('finish: обязательны --stage и --status');
  }

  const dir = cycleDir(args);
  assertWritableDir(dir, root);
  const file = join(dir, FIXED_NAMES.state);
  const state = readState(file);

  const next = finishStage(state, {
    stage: args.stage,
    status: args.status,
    detail: args.detail,
    now: resolveNow(args),
  });

  writeState(file, next);
  printJson(next);
  return 0;
}

/**
 * `apply-decision`: решение текущей итерации → переход и счётчики. Повторный запуск с тем
 * же решением (совпадают `iteration`, `action`, `retry_stage` и `digest`) — no-op (0), файл
 * не перезаписывается. Изменённое содержимое `decision.<n>.json` — новое решение: оно
 * применяется по общим правилам (а в терминальном состоянии или вне DECIDE — код 3).
 * @param {ReturnType<typeof parseArgs>} args
 * @param {string} root
 * @returns {number} код выхода
 */
function runApplyDecision(args, root) {
  const dir = cycleDir(args);
  assertWritableDir(dir, root);
  const file = join(dir, FIXED_NAMES.state);
  const state = readState(file);
  const now = resolveNow(args);
  const names = iterNames(state.iteration);

  const decision = readDecisionRequired(join(dir, names.decision), state.iteration);
  const marker = decisionMarker(decision);
  if (markerMatches(state.applied_decision, marker)) {
    // Идемпотентность: счётчики уже учтены, состояние не трогаем.
    printJson(state);
    return 0;
  }

  /** @type {Record<string, any>|null} */
  let escalation = null;
  if (decision.action === 'ESCALATE') {
    escalation = buildEscalation({
      reason: escalationReasonFromDecision(decision),
      detail:
        Array.isArray(decision.reasons) && decision.reasons.length > 0
          ? decision.reasons.join('; ')
          : null,
      ...escalationEnv(dir, state),
    });
    assertValidEscalation(escalation);
  }

  const next = {
    ...applyDecisionToState(state, { decision, now, escalation }),
    applied_decision: marker,
  };

  // escalation.json пишется до состояния: state остаётся источником истины, а лишний
  // документ будет перезаписан следующим запуском.
  if (escalation !== null) {
    writeJsonAtomic(join(dir, FIXED_NAMES.escalation), normalizeDoc(escalation), {
      serialize: serializeArtifact,
    });
  }
  writeState(file, next);
  printJson(next);
  return 0;
}

/**
 * `escalate --reason R [--detail T]`: `escalation.json`, закрытие открытого этапа и
 * переход в ESCALATED.
 * @param {ReturnType<typeof parseArgs>} args
 * @param {string} root
 * @returns {number} код выхода
 */
function runEscalate(args, root) {
  if (args.reason === null) throw new UsageError('escalate: обязателен --reason');
  if (!isValidEscalationReason(args.reason)) {
    throw new UsageError(
      `--reason: неизвестная причина ${JSON.stringify(args.reason)} (словарь D7)`,
    );
  }

  const dir = cycleDir(args);
  assertWritableDir(dir, root);
  const file = join(dir, FIXED_NAMES.state);
  const state = readState(file);
  const now = resolveNow(args);

  const escalation = buildEscalation({
    reason: args.reason,
    detail: args.detail,
    ...escalationEnv(dir, state),
  });
  assertValidEscalation(escalation);

  const next = escalateToState(state, { escalation, now });

  writeJsonAtomic(join(dir, FIXED_NAMES.escalation), normalizeDoc(escalation), {
    serialize: serializeArtifact,
  });
  writeState(file, next);
  printJson(next);
  return 0;
}

/**
 * `resume`: первый незавершённый этап и допустимые следующие шаги.
 * @param {ReturnType<typeof parseArgs>} args
 * @returns {number} код выхода
 */
function runResume(args) {
  const dir = cycleDir(args);
  const state = readState(join(dir, FIXED_NAMES.state));
  const target = resumeTarget(state);

  printJson({
    command: 'resume',
    dir,
    stage: state.stage,
    iteration: state.iteration,
    stage_status: state.stage_status,
    action: target.action,
    allowed_next: target.allowed_next,
  });
  return 0;
}

/**
 * Каталог файла блокировки: `.pi/artifacts/` или `dirname(--dir)`.
 * @param {{ dir: string|null }} args
 * @param {string} root
 * @returns {string}
 */
function lockDir(args, root) {
  return args.dir === null ? artifactsDir(root) : dirname(resolve(args.dir));
}

/**
 * Жив ли процесс. EPERM означает «жив, но не наш» — освобождать lock в этом случае нельзя.
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code !== 'ESRCH';
  }
}

/**
 * Разобранный lock-файл: `null`, если файл битый или без числового `pid` (тогда он считается
 * устаревшим — иначе битый lock держал бы дерево вечно).
 * @param {string} file
 * @returns {{ pid: number, slug: string|null, created_at: string }|null}
 */
function readLock(file) {
  /** @type {unknown} */
  let doc;
  try {
    doc = readJson(file);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null) return null;

  const lock = /** @type {Record<string, any>} */ (doc);
  if (!Number.isInteger(lock.pid) || lock.pid < 1) return null;
  return {
    pid: lock.pid,
    slug: typeof lock.slug === 'string' ? lock.slug : null,
    created_at: typeof lock.created_at === 'string' ? lock.created_at : '',
  };
}

/**
 * `stat` или `null`, если файла нет (гонка с удалением) — без исключений в вызывающем коде.
 * @param {string} file
 * @returns {import('node:fs').Stats|null}
 */
function statOrNull(file) {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

/**
 * Эксклюзивное создание lock-файла (`openSync(..., 'wx')`): проверка и запись не разнесены,
 * поэтому два параллельных `lock` не могут оба посчитать файл отсутствующим.
 *
 * После записи inode открытого дескриптора сверяется с inode по пути: если файл успели
 * удалить как «битый» и создать заново, наша блокировка уже чужая — это конфликт (код 3),
 * а не успех.
 * @param {string} file путь lock-файла
 * @param {string} text готовый документ (pretty JSON + `\n`)
 * @returns {boolean} `true` — захвачено, `false` — файл уже существует (`EEXIST`)
 */
function createLockFile(file, text) {
  /** @type {number} */
  let fd;
  try {
    fd = openSync(file, 'wx');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') return false;
    throw error;
  }

  /** @type {import('node:fs').Stats} */
  let opened;
  try {
    opened = fstatSync(fd);
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }

  const placed = statOrNull(file);
  if (placed === null || placed.ino !== opened.ino || placed.dev !== opened.dev) {
    throw new ConflictError(
      `lock потерян во время захвата: ${file} заменён другим процессом (§13)`,
    );
  }
  return true;
}

/**
 * Возраст файла в миллисекундах (по `mtime`).
 * @param {import('node:fs').Stats} stats
 * @param {number} nowMs текущее время, мс
 * @returns {number}
 */
function ageMs(stats, nowMs) {
  return nowMs - stats.mtimeMs;
}

/**
 * Состояние lock-файла для принятия решения о захвате.
 * @param {string} file путь lock-файла
 * @param {number} nowMs текущее время, мс
 * @returns {{ kind: 'missing' } | { kind: 'busy', lock: { pid: number, slug: string|null, created_at: string } | null } | { kind: 'stale', ino: number }} результат осмотра
 */
function inspectLock(file, nowMs) {
  const stats = statOrNull(file);
  if (stats === null) return { kind: 'missing' };

  if (stats.size === 0) {
    // Пустой файл: активный захват, пока не истёк TTL. Старше — сбой процесса.
    return ageMs(stats, nowMs) < LOCK_EMPTY_TTL_MS
      ? { kind: 'busy', lock: null }
      : { kind: 'stale', ino: stats.ino };
  }

  const parsed = readLock(file);
  if (parsed !== null && isProcessAlive(parsed.pid)) return { kind: 'busy', lock: parsed };
  return { kind: 'stale', ino: stats.ino };
}

/**
 * Забирает устаревший файл у пути, не удаляя его «вслепую». Между осмотром (`statSync`) и
 * снятием файл может быть заменён конкурентным процессом, поэтому удаления по пути нет:

 * 1. файл **переименовывается** в уникальное имя (`<file>.stale.<pid>.<ms>`);
 * 2. по переименованному сверяется inode: свой экземпляр — удаляем, чужой (свежий) — возвращаем;
 * 3. возврат идёт через `linkSync` + `unlinkSync`, а не `renameSync`: `rename` **заменяет**
 *    цель, поэтому мог бы затереть `.lock`, созданный третьим процессом (BLOCKER ревью):
 *    если канонический путь уже занят, восстановление не делается, а конфликт сообщается
 *    явно — осмотренный файл остаётся под именем `<file>.stale.…`, его можно разобрать руками.
 *
 * Экспортируется ради тестов (как `TRANSITIONS`/`mandatoryGatesGreen`): подмену файла между
 * осмотром и снятием, а также восстановление в занятый путь иначе не проверить.
 * @param {string} file путь устаревшего файла
 * @param {number} expectedIno inode, который осматривали
 * @param {{ afterMove?: (moved: string) => void }} [hooks] тестовый хук: вызывается сразу после переименования
 * @returns {'claimed' | 'gone' | 'other'} результат: сняли свой экземпляр / файла уже нет / чужой возвращён
 * @throws {ConflictError} чужой файл вернуть не удалось (канонический путь занят)
 */
export function claimStaleFile(file, expectedIno, hooks = {}) {
  const tmp = `${file}.stale.${process.pid}.${Date.now()}`;
  try {
    renameSync(file, tmp);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return 'gone';
    throw error;
  }

  // Возраст перемещённого файла должен означать возраст переноса, а не исходного файла:
  // `renameSync` сохраняет `mtime`, и уборщик остатков (`sweepStaleArtifacts`) удалил бы файл
  // прямо во время переноса (MAJOR ревью итерации 3).
  const movedAt = new Date();
  utimesSync(tmp, movedAt, movedAt);

  hooks.afterMove?.(tmp);

  const stats = statOrNull(tmp);
  if (stats !== null && stats.ino === expectedIno) {
    try {
      unlinkSync(tmp);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
    }
    return 'claimed';
  }

  // Это чужой (свежий) файл: возвращаем его на канонический путь, но никогда не заменяем цель.
  try {
    linkSync(tmp, file);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    // Перемещённого файла уже нет (его убрала уборка остатков или конкурент): восстанавливать
    // нечего — это обычный исход гонки, а не ошибка выполнения.
    if (code === 'ENOENT') return 'gone';
    if (code !== 'EEXIST') throw error;
    throw new ConflictError(
      `lock перехвачен конкурентным процессом: ${file} занят, осмотренный файл сохранён как ${tmp} (§13)`,
    );
  }
  try {
    unlinkSync(tmp);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
  }
  return 'other';
}

/**
 * Убирает остатки `*.stale.*` от прерванных восстановлений. Такие файлы появляются только
 * между `rename` и `unlink`, поэтому старые (старше TTL) можно смело удалять: актуального
 * владельца в них быть не может.
 *
 * Возраст считается по метке переноса **из имени** (`<lock>.stale.<pid>.<ms>`), а не по `mtime`:
 * с момента правки итерации 3 `claimStaleFile` обновляет `mtime` перемещённого файла, но имя
 * остаётся более надёжным источником (и не зависит от правки времени на файле).
 * @param {string} dir каталог артефактов
 * @param {string} lockName имя lock-файла
 * @param {number} nowMs текущее время, мс
 * @returns {number} сколько остатков убрано
 */
function sweepStaleArtifacts(dir, lockName, nowMs) {
  let removed = 0;
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(`${lockName}.stale.`)) continue;
    const path = join(dir, name);
    const stats = statOrNull(path);
    if (stats === null) continue;
    const stamp = /\.stale\.\d+\.(\d+)$/.exec(name);
    const age = stamp === null ? ageMs(stats, nowMs) : nowMs - Number(stamp[1]);
    if (age < LOCK_TAKEOVER_TTL_MS) continue;
    try {
      unlinkSync(path);
      removed += 1;
    } catch {
      // не смогли — не наша ошибка: файл простоит до следующего запуска
    }
  }
  return removed;
}

/**
 * Захватывает право на восстановление lock-файла: эксклюзивно создаёт `<lock>.takeover`.
 * Пока он свеж, второй процесс не снимает lock — иначе снял бы уже свежую блокировку первого.
 * Заброшенный сериализатор (мёртвый pid или старше TTL) снимается и захватывается заново.
 * @param {string} file путь lock-файла
 * @param {string} text документ сериализатора
 * @param {number} nowMs текущее время, мс
 * @returns {boolean} `true`, если право получено
 */
function acquireTakeover(file, text, nowMs) {
  const takeover = `${file}${LOCK_TAKEOVER_SUFFIX}`;
  if (createLockFile(takeover, text)) return true;

  const stats = statOrNull(takeover);
  if (stats === null) return createLockFile(takeover, text); // файл исчез между попытками

  const parsed = readLock(takeover);
  // TTL действует и на живой pid: сериализатор держит сам `cycle-state` (миллисекунды), поэтому
  // «живой» pid через 30 с — это либо переиспользованный pid, либо аварийно завершённая команда.
  const abandoned =
    ageMs(stats, nowMs) >= LOCK_TAKEOVER_TTL_MS || (parsed !== null && !isProcessAlive(parsed.pid));
  if (!abandoned) return false;

  const claim = claimStaleFile(takeover, stats.ino);
  if (claim === 'other') return false; // кто-то успел перевыпустить сериализатор — уступаем
  return createLockFile(takeover, text);
}

/**
 * Освобождает право на восстановление, если оно наше.
 * @param {string} file путь lock-файла
 * @returns {void}
 */
function releaseTakeover(file) {
  const takeover = `${file}${LOCK_TAKEOVER_SUFFIX}`;
  try {
    unlinkSync(takeover);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
  }
}

/**
 * Конфликт «цикл уже идёт»: тот же текст, что и раньше (код 3).
 * @param {string} file
 * @param {{ pid: number, slug: string|null, created_at: string }} lock
 * @returns {ConflictError}
 */
function lockBusyError(file, lock) {
  const slug = lock.slug === null ? '' : `, slug ${lock.slug}`;
  return new ConflictError(
    `цикл уже идёт в этом дереве: ${file} (pid ${lock.pid}${slug}, ` +
      `создан ${lock.created_at}); устаревший lock снимается сам (§13)`,
  );
}

/**
 * `lock`: один цикл на рабочее дерево (§13). Захват атомарный: живой pid — код 3,
 * мёртвый или битый lock снимается (`unlinkSync`) с одной повторной попыткой.
 *
 * В `pid` пишется идентификатор родительского процесса, а не своего: `cycle-state` живёт
 * миллисекунды, и его pid умер бы раньше, чем цикл начнёт работу, — тогда lock не мешал бы
 * никому. Родитель — процесс, который ведёт цикл (супервизор pi), он и держит блокировку,
 * пока цикл идёт. Если родителя нет (ppid 0/1), используется собственный pid.
 * @param {ReturnType<typeof parseArgs>} args
 * @param {string} root
 * @returns {number} код выхода
 */
function runLock(args, root) {
  const dir = lockDir(args, root);
  assertWritableDir(dir, root);
  const file = join(dir, LOCK_NAME);
  mkdirSync(dir, { recursive: true });

  const owner = process.ppid > 1 ? process.ppid : process.pid;
  const lock = { pid: owner, slug: args.slug, created_at: resolveNow(args) };
  const text = serializeArtifact(normalizeDoc(lock));
  // Время для TTL — только настенные часы: `--now` задаёт документ, а не решение о устаревании.
  const nowMs = Date.now();
  // Остатки прерванных восстановлений не должны копиться (MINOR ревью итерации 3).
  sweepStaleArtifacts(dir, LOCK_NAME, nowMs);

  if (createLockFile(file, text)) {
    printJson(lock);
    return 0;
  }

  // Быстрая проверка без сериализатора: живой цикл или свежий незавершённый захват.
  const verdict = inspectLock(file, nowMs);
  if (verdict.kind === 'busy') {
    if (verdict.lock !== null) throw lockBusyError(file, verdict.lock);
    throw new ConflictError(
      `lock создаётся прямо сейчас другим процессом: ${file} (§13; заброшенный пустой файл ` +
        `снимется сам через ${LOCK_EMPTY_TTL_MS / 1000} с или командой unlock)`,
    );
  }

  // Восстановление — только под сериализатором: иначе два процесса снимут lock по очереди и
  // второй снесёт уже свежую блокировку первого (issue #157, ревью 2).
  // Сериализатор держим мы сами (миллисекунды), поэтому в документе — наш pid, а не родителя.
  const takeoverDoc = { pid: process.pid, slug: args.slug, created_at: resolveNow(args) };
  if (!acquireTakeover(file, serializeArtifact(normalizeDoc(takeoverDoc)), nowMs)) {
    throw new ConflictError(
      `lock восстанавливается другим процессом: ${file}${LOCK_TAKEOVER_SUFFIX} (§13; ` +
        'повторите попытку)',
    );
  }
  try {
    // Под сериализатором перепроверяем: пока мы ждали, состояние могло измениться.
    const second = inspectLock(file, nowMs);
    if (second.kind === 'busy') {
      if (second.lock !== null) throw lockBusyError(file, second.lock);
      throw new ConflictError(`lock создаётся прямо сейчас другим процессом: ${file} (§13)`);
    }
    if (second.kind === 'stale') {
      const claim = claimStaleFile(file, second.ino);
      if (claim === 'other') {
        throw new ConflictError(
          `lock устарел, но его перевыпустил другой процесс во время восстановления: ${file} (§13)`,
        );
      }
    }
    if (createLockFile(file, text)) {
      printJson(lock);
      return 0;
    }
    throw new ConflictError(
      `lock не захвачен: ${file} пересоздан конкурентным процессом во время восстановления (§13)`,
    );
  } finally {
    releaseTakeover(file);
  }
}

/**
 * `unlock`: безусловное снятие блокировки; отсутствующий файл — no-op с кодом 0.
 * @param {ReturnType<typeof parseArgs>} args
 * @param {string} root
 * @returns {number} код выхода
 */
function runUnlock(args, root) {
  const dir = lockDir(args, root);
  assertWritableDir(dir, root);
  const file = join(dir, LOCK_NAME);

  let released = false;
  if (existsSync(file)) {
    unlinkSync(file);
    released = true;
  }

  printJson({ command: 'unlock', dir, released });
  return 0;
}

/**
 * Диспетчер подкоманд.
 * @param {ReturnType<typeof parseArgs>} args
 * @param {string} root
 * @returns {number} код выхода
 */
function run(args, root) {
  switch (args.command) {
    case 'init':
      return runInit(args, root);
    case 'get':
      return runGet(args);
    case 'advance':
      return runAdvance(args, root);
    case 'finish':
      return runFinish(args, root);
    case 'apply-decision':
      return runApplyDecision(args, root);
    case 'escalate':
      return runEscalate(args, root);
    case 'resume':
      return runResume(args);
    case 'lock':
      return runLock(args, root);
    default:
      return runUnlock(args, root);
  }
}

/**
 * Точка входа CLI. Единственный вывод — строка JSON в stdout, диагностика — в stderr;
 * конфликт состояния даёт код 3, всё остальное — 2.
 * @returns {void}
 */
function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    process.exitCode = run(args, repoRoot());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cycle-state: ${message}\n`);
    process.exitCode = error instanceof ConflictError ? 3 : 2;
  }
}

// Модуль импортируется тестами ради чистого ядра; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
