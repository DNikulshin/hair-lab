#!/usr/bin/env node
/**
 * Раннер гейтов цикла по docs/orchestrator-core.md §5.5 (issue #154, задача T3).
 *
 * Вход: `state.json` каталога цикла (`iteration`, `base_sha`), дифф рабочего дерева от
 * базы. Выход: `gates.<n>.json` (Приложение A) и логи `gates/<id>.<n>.log`; в stdout —
 * одна строка JSON того же документа, диагностика — в stderr.
 *
 * `--base` переопределяет `state.base_sha` и может быть именем ссылки (`main`), но
 * `base_sha` документа обязан быть полным sha (Приложение A), поэтому база резолвится в
 * sha до диффа (`resolveBaseSha`) и в документ попадает уже разрешённое значение.
 * Нерезолвящаяся или недопустимая ссылка — ошибка использования: код 2, документ не пишется.
 *
 * Гейты выполняются последовательно в порядке таблицы `GATES` (§5.5), без оболочки:
 * команда из `cmd` разбивается по пробелам, аргументы не интерполируются. Зависимость
 * `dependsOn` даёт `not_run` с причиной `blocked_by:<id>`, если родитель в этом прогоне
 * оказался в `fail`/`not_run`; остальные гейты выполняются независимо. Условие запуска —
 * `pathPrefixes` (префикс пути или точное совпадение, как `AGENTS.md`), иначе `skipped`
 * с причиной `not_applicable`. Пропуск не считается непроверенным (docs/orchestrator.md).
 *
 * `--only id,id` (уточнение супервизора к плану, п. 1–2): выполняются только выбранные
 * гейты, невыбранные берут статус из существующего `gates.<n>.json` того же каталога и
 * итерации (нет файла — `not_run` без причины), а результат всё равно содержит все гейты
 * в порядке таблицы. Для этого невыбранные гейты наследуют `status`/`exit`/`duration_s`/
 * `log`/`reason`, а `cmd`/`required` берутся из таблицы: документ остаётся цельным.
 * Битый или невалидный прежний `gates.<n>.json` при непустом `--only` — код 2.
 *
 * Перед диффом вызывается `intentToAddUntracked()` (§4): без него новые файлы не видны ни
 * в условиях гейтов, ни в `secrets_scan`. `test_int` запускается как есть, без проверки
 * соединения с БД: класс отказа определяется по логу (`no_database` для ошибок соединения,
 * `fail` для всего остального, включая `password authentication failed`).
 *
 * Инъекция для тестов (§5.10): `runGates` принимает `definitions`, `runner`, `now`,
 * `timeouts`, `graceMs`, `added`, `dir`. Тесты не запускают реальные гейты, не вызывают
 * `pnpm` и сеть; единственный реальный процесс — тест тайм-аута с потомком во временном
 * каталоге. Детерминизм: время приходит только через `now`, ключи документа сортируются
 * (`normalizeDoc`), списки строятся в фиксированном порядке.
 *
 * Коды выхода (§5.5): `0` — обязательных `fail` нет; `1` — есть; `2` — внутренняя ошибка
 * или ошибка использования (в этом случае `gates.<n>.json` не пишется и не перезаписывается).
 *
 * Shebang нужен: файл запускается напрямую.
 */
import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { normalizeDoc } from './cycle-decide.mjs';
import { GATES, GATE_TIMEOUTS, LIMITS } from './lib/cycle/config.mjs';
import {
  addedLinesByFile,
  baseSha,
  changedFiles,
  diffFromBase,
  intentToAddUntracked,
} from './lib/cycle/git.mjs';
import { readJson, tail, writeJsonAtomic } from './lib/cycle/io.mjs';
import { FIXED_NAMES, findActiveCycle, iterNames, repoRoot } from './lib/cycle/paths.mjs';
import { scanSecrets } from './lib/cycle/redact.mjs';
import { validateGates, validateState } from './lib/cycle/validate.mjs';

/** Гейт с классификацией отказа по логу (§5.5): без БД — `not_run`, иначе `fail`. */
const TEST_INT = 'test_int';

/** Причины гейтов §5.5/Приложение A. */
const NOT_APPLICABLE = 'not_applicable';
const NO_DATABASE = 'no_database';
const TIMEOUT = 'timeout';
const TOOL_MISSING = 'tool_missing';

/** Статусы родителя, при которых зависимый гейт не запускается (§5.5). */
const BLOCKING_STATUSES = Object.freeze(['fail', 'not_run']);

/** Подкаталог логов гейтов внутри каталога цикла. */
const LOGS_DIR = 'gates';

/** Единственное исключение `secrets_scan` (§5.5): шаблон окружения не считается секретом. */
const ENV_EXAMPLE = '.env.example';

/** Ссылка на текущий коммит: `baseSha` с `branch: 'HEAD'` даёт sha HEAD без новой функции в lib. */
const HEAD_REV = 'HEAD';

/** Полный sha: `base_sha` документа принимается только в этом виде (Приложение A). */
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Тайм-аут гейта вне таблицы `GATE_TIMEOUTS` (тестовый конфиг §5.10), мс. */
const DEFAULT_GATE_TIMEOUT_MS = 300_000;

/** Пауза между SIGTERM и SIGKILL группе процессов, мс. */
const KILL_GRACE_MS = 2_000;

/**
 * Признаки того, что `test_int` не дошёл до БД (§5.5). Присвоение секрета, тайм-аут и
 * любая другая ошибка сюда не входят — они остаются `fail`.
 */
const NO_DATABASE_PATTERNS = Object.freeze([
  /ECONNREFUSED/,
  /ENOTFOUND/,
  /P1001/,
  /Can't reach database server/i,
]);

/**
 * @typedef {object} GateOutcome
 * @property {'pass'|'fail'|'not_run'} status итог запуска
 * @property {number|null} exit код возврата процесса (`null` — нет кода)
 * @property {number} duration_s длительность в секундах
 * @property {string|null} reason причина §5.5 или `null`
 */

/**
 * @typedef {object} GateEntry
 * @property {string} id
 * @property {string|null} cmd
 * @property {boolean} required
 * @property {'pass'|'fail'|'skipped'|'not_run'} status
 * @property {number|null} exit
 * @property {number} duration_s
 * @property {string|null} log путь лога относительно каталога цикла
 * @property {string|null} reason
 */

/**
 * @typedef {object} GatePlanItem
 * @property {string} id
 * @property {'run'|'skip'|'inherit'} decision что делать с гейтом в этом прогоне
 * @property {string|null} reason причина для `skipped`/`not_run` или `null`
 */

/**
 * Непустая строка после обрезки пробелов.
 * @param {unknown} value
 * @returns {boolean}
 */
function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Запускается ли гейт при таком диффе (§5.5). Пустой список префиксов — «всегда»;
 * точное совпадение нужно для условий-файлов (`AGENTS.md`), префикс — для каталогов.
 * @param {{ pathPrefixes: readonly string[] }} definition
 * @param {string[]} changed изменённые файлы от базы
 * @returns {boolean}
 */
export function isGateApplicable(definition, changed) {
  if (definition.pathPrefixes.length === 0) return true;
  return changed.some((file) =>
    definition.pathPrefixes.some((prefix) => file === prefix || file.startsWith(prefix)),
  );
}

/**
 * План прогона: порядок, условие запуска и наследование статусов при `--only`.
 * Чистая функция — процессы не запускает и файлов не читает. Зависимости разрешает
 * `runGates`: статус родителя известен только после его выполнения, а наследованный
 * статус родителя уже есть в `inherited` (уточнение супервизора, п. 1).
 * @param {readonly { id: string, pathPrefixes: readonly string[] }[]} definitions
 * @param {{ changed?: string[], only?: string[]|null, inherited?: Record<string, GateEntry> }} [options]
 * @returns {GatePlanItem[]}
 */
export function planRun(definitions, { changed = [], only = null, inherited = {} } = {}) {
  const selected = only === null ? null : new Set(only);

  return definitions.map((definition) => {
    if (selected !== null && !selected.has(definition.id)) {
      return {
        id: definition.id,
        decision: 'inherit',
        reason: inherited[definition.id]?.reason ?? null,
      };
    }
    if (!isGateApplicable(definition, changed)) {
      return { id: definition.id, decision: 'skip', reason: NOT_APPLICABLE };
    }
    return { id: definition.id, decision: 'run', reason: null };
  });
}

/**
 * Классифицирует лог `test_int` (§5.5): ошибки соединения — `no_database`, всё остальное,
 * включая `password authentication failed`, — `fail`. Чистая функция: вход — только текст
 * лога, поэтому тесты идут на образцах из `scripts/fixtures/cycle/`.
 * @param {string} text содержимое лога гейта
 * @returns {'no_database'|'fail'}
 */
export function classifyTestIntLog(text) {
  if (typeof text !== 'string') throw new TypeError('classifyTestIntLog: ожидается строка');
  return NO_DATABASE_PATTERNS.some((pattern) => pattern.test(text)) ? NO_DATABASE : 'fail';
}

/**
 * Файл `.env.example` — единственное исключение `secrets_scan`. Регистр не важен;
 * проверяются полный путь (`config/.env.example`) и имя файла в корне.
 * @param {string} file
 * @returns {boolean}
 */
function isEnvExample(file) {
  const lower = file.toLowerCase();
  return lower === ENV_EXAMPLE || lower.endsWith(`/${ENV_EXAMPLE}`);
}

/**
 * Находки `secrets_scan` по добавленным строкам диффа (§5.5): только `file:line` и вид
 * находки, значение секрета не сохраняется. Файл `.env.example` — единственное исключение.
 * `scanSecrets` нумерует строки относительно переданного массива, поэтому номер строки
 * в файле берётся из соответствующего элемента `addedLinesByFile`.
 * @param {{ file: string, lines: { line: number, text: string }[] }[]} files
 * @returns {{ file: string, line: number, kind: string }[]}
 */
export function scanAddedLines(files) {
  if (!Array.isArray(files)) {
    throw new TypeError('scanAddedLines: ожидается массив файлов с добавленными строками');
  }

  /** @type {{ file: string, line: number, kind: string }[]} */
  const findings = [];

  for (const entry of files) {
    if (isEnvExample(entry.file)) continue;
    const lines = entry.lines.map((line) => line.text);
    for (const finding of scanSecrets(lines)) {
      findings.push({
        file: entry.file,
        line: entry.lines[finding.line - 1].line,
        kind: finding.kind,
      });
    }
  }

  return findings;
}

/**
 * Строка лога находки: `file:line <kind>` без значения секрета (§5.5).
 * @param {{ file: string, line: number, kind: string }} finding
 * @returns {string}
 */
function formatFinding(finding) {
  return `${finding.file}:${finding.line} ${finding.kind}`;
}

/**
 * Относительный путь лога гейта: `gates/<id>.<n>.log`.
 * @param {string} id
 * @param {number} iteration
 * @returns {string}
 */
function logRelativePath(id, iteration) {
  return `${LOGS_DIR}/${id}.${iteration}.log`;
}

/**
 * Оставляет в логе хвост, укладывающийся в `LIMITS.logMaxBytes` (§5.2, §5.5).
 * `io.tail` отрезает по строкам, поэтому подходящее число строк ищется делением отрезка:
 * каждая строка занимает минимум один байт, значит строк не больше, чем байт в файле.
 * Путь редкий (5 МБ вывода одного гейта — уже аномалия), поэтому повторное чтение хвоста
 * на каждом шаге приемлемо. `tail` отдаёт хвост без завершающего перевода строки —
 * возвращаем его, чтобы файл оставался текстовым логом.
 * @param {string} file
 * @returns {boolean} true, если лог был обрезан
 */
export function trimLog(file) {
  const size = statSync(file).size;
  if (size <= LIMITS.logMaxBytes) return false;

  let low = 0;
  let high = size;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(tail(file, mid), 'utf8') <= LIMITS.logMaxBytes) low = mid;
    else high = mid - 1;
  }

  const kept = tail(file, low);
  writeFileSync(file, kept === '' ? '' : `${kept}\n`);
  return true;
}

/**
 * Сигнал группе процессов гейта. `detached: true` делает процесс лидером группы, поэтому
 * `kill(-pid)` завершает и его потомков (§5.5: тайм-аут завершает процесс и потомков).
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 * @returns {void}
 */
function killGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Группы может уже не быть: процесс завершился раньше сигнала — это штатный случай.
  }
}

/**
 * Окружение процесса гейта: наследуется от текущего процесса плюс `TURBO_FORCE=true`.
 *
 * Без этого turbo отдаёт результат из кэша («FULL TURBO»), и `pass` в `gates.<n>.json`
 * означал бы «эти входы когда-то уже проверялись», а не живой прогон (§5.5, #216). Кэш
 * turbo адресуется по хешу входов, но часть окружения в хеш не входит, а гейты — основное
 * свидетельство «код проверен»; цена принудительного прогона в этом репозитории — секунды
 * (contracts_build 3 с, typecheck 11 с, lint 9 с, test 12 с), поэтому выбирается свежесть.
 * Затрагивает только задачи turbo: `test_int` в `turbo.json` уже `cache: false`, а
 * `check_arch`, `check_harness`, `format_check`, `lint:workflows` и `test:scripts`
 * кэша не имеют.
 * @param {NodeJS.ProcessEnv} [base] базовое окружение (в тестах — подмена)
 * @returns {NodeJS.ProcessEnv} окружение для `spawn`
 */
export function gateEnv(base = process.env) {
  return { ...base, TURBO_FORCE: 'true' };
}

/**
 * Запуск команды гейта без оболочки: `cmd` разбивается по пробелам, аргументы не
 * интерполируются. Вывод (stdout+stderr) пишется в лог; при превышении `LIMITS.logMaxBytes`
 * в логе остаётся хвост. Тайм-аут: SIGTERM группе → пауза `graceMs` → SIGKILL → `fail`
 * с причиной `timeout`. Эскалация запускается сразу по тайм-ауту и не отменяется
 * закрытием лидера: потомок мог проигнорировать SIGTERM и не держать открытыми
 * stdout/stderr, поэтому SIGKILL группе отправляется безусловно (§5.5). Отсутствие
 * команды (`ENOENT`) — `fail` с причиной `tool_missing`.
 * @param {import('./lib/cycle/config.mjs').GateDefinition} definition
 * @param {{
 *   cwd: string,
 *   logFile: string,
 *   timeoutMs?: number,
 *   graceMs?: number,
 *   now?: () => number,
 * }} options
 * @returns {Promise<GateOutcome>}
 */
async function runCommandGate(
  definition,
  { cwd, logFile, timeoutMs = DEFAULT_GATE_TIMEOUT_MS, graceMs = KILL_GRACE_MS, now = Date.now },
) {
  const [command, ...args] = String(definition.cmd)
    .split(/\s+/)
    .filter((part) => part !== '');
  const startedMs = now();
  const stream = createWriteStream(logFile);
  /** @type {Error|null} */
  let spawnError = null;
  let timedOut = false;
  /** @type {Promise<void>} */
  let escalation = Promise.resolve();

  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: gateEnv(),
  });
  child.on('error', (error) => {
    spawnError = error;
  });
  if (child.stdout !== null) child.stdout.pipe(stream, { end: false });
  if (child.stderr !== null) child.stderr.pipe(stream, { end: false });

  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child, 'SIGTERM');
    // SIGKILL группе планируется сразу и не отменяется событием `close` лидера: потомок,
    // который проигнорировал SIGTERM и не держит stdout/stderr, иначе выжил бы (§5.5).
    escalation = sleep(graceMs).then(() => killGroup(child, 'SIGKILL'));
  }, timeoutMs);

  const code = await new Promise((resolveClose) => {
    child.once('close', (exitCode) => resolveClose(exitCode));
  });

  clearTimeout(timer);
  // Ждём доставку SIGKILL группе, чтобы прогон не возвращался, пока потомки живы.
  if (timedOut) await escalation;

  stream.end();
  await finished(stream);
  trimLog(logFile);

  const duration_s = Number(((now() - startedMs) / 1000).toFixed(3));
  if (spawnError !== null) {
    return { status: 'fail', exit: null, duration_s, reason: TOOL_MISSING };
  }
  if (timedOut) return { status: 'fail', exit: null, duration_s, reason: TIMEOUT };

  const exit = typeof code === 'number' ? code : null;
  return { status: exit === 0 ? 'pass' : 'fail', exit, duration_s, reason: null };
}

/**
 * Запись гейта в форме Приложения A.
 * @param {import('./lib/cycle/config.mjs').GateDefinition} definition
 * @param {{ status: GateEntry['status'], exit?: number|null, duration_s?: number, log?: string|null, reason?: string|null }} fields
 * @returns {GateEntry}
 */
function makeEntry(definition, fields) {
  return {
    id: definition.id,
    cmd: definition.cmd,
    required: definition.required,
    status: fields.status,
    exit: fields.exit ?? null,
    duration_s: fields.duration_s ?? 0,
    log: fields.log ?? null,
    reason: fields.reason ?? null,
  };
}

/**
 * Читает лог гейта для классификации; отсутствующий файл — пустой текст (гейт мог
 * упасть до записи лога).
 * @param {string} dir каталог цикла
 * @param {string} relative путь относительно каталога цикла
 * @returns {string}
 */
function readGateLog(dir, relative) {
  const file = join(dir, relative);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/**
 * Выполнение одного гейта: процесс через `runner` или встроенный `secrets_scan`.
 * @param {import('./lib/cycle/config.mjs').GateDefinition} definition
 * @param {{
 *   dir: string,
 *   root: string,
 *   added: { file: string, lines: { line: number, text: string }[] }[],
 *   iteration: number,
 *   timeouts: Record<string, number>,
 *   graceMs: number,
 *   now: () => number,
 *   runner: (definition: import('./lib/cycle/config.mjs').GateDefinition, options: any) => Promise<GateOutcome>,
 * }} context
 * @returns {Promise<GateEntry>}
 */
async function executeGate(definition, context) {
  const { dir, root, added, iteration, timeouts, graceMs, now, runner } = context;
  const log = logRelativePath(definition.id, iteration);

  if (definition.cmd === null) {
    // Единственная встроенная проверка таблицы — `secrets_scan`: лог пишется только при
    // находках и содержит `file:line <kind>` без значения секрета (§5.5).
    const findings = scanAddedLines(added);
    if (findings.length === 0) {
      return makeEntry(definition, { status: 'pass', duration_s: 0 });
    }
    mkdirSync(join(dir, LOGS_DIR), { recursive: true });
    writeFileSync(join(dir, log), `${findings.map(formatFinding).join('\n')}\n`);
    return makeEntry(definition, { status: 'fail', duration_s: 0, log });
  }

  mkdirSync(join(dir, LOGS_DIR), { recursive: true });
  const outcome = await runner(definition, {
    cwd: root,
    logFile: join(dir, log),
    timeoutMs: timeouts[definition.id] ?? DEFAULT_GATE_TIMEOUT_MS,
    graceMs,
    now,
  });

  if (definition.id === TEST_INT && outcome.status === 'fail') {
    // §5.5: класс отказа `test_int` определяется по логу, а не по коду возврата.
    const kind = classifyTestIntLog(readGateLog(dir, log));
    if (kind === NO_DATABASE) {
      return makeEntry(definition, { ...outcome, status: 'not_run', log, reason: NO_DATABASE });
    }
  }

  return makeEntry(definition, { ...outcome, log });
}

/**
 * Полный прогон: план, последовательное выполнение, зависимости и записи гейтов.
 * Чистая относительно файловой системы — пишет только `secrets_scan` и (через `runner`)
 * логи гейтов; `gates.<n>.json` формируется здесь и пишется вызывающим.
 * @param {{
 *   definitions?: readonly import('./lib/cycle/config.mjs').GateDefinition[],
 *   changed?: string[],
 *   added?: { file: string, lines: { line: number, text: string }[] }[],
 *   only?: string[]|null,
 *   inherited?: Record<string, GateEntry>,
 *   iteration: number,
 *   dir: string,
 *   root?: string,
 *   timeouts?: Record<string, number>,
 *   graceMs?: number,
 *   now?: () => number,
 *   runner?: (definition: import('./lib/cycle/config.mjs').GateDefinition, options: any) => Promise<GateOutcome>,
 * }} options
 * @returns {Promise<{ started_at: string, gates: GateEntry[] }>}
 */
export async function runGates(options) {
  const {
    definitions = GATES,
    changed = [],
    added = [],
    only = null,
    inherited = {},
    iteration,
    dir,
    root = process.cwd(),
    timeouts = GATE_TIMEOUTS,
    graceMs = KILL_GRACE_MS,
    now = Date.now,
    runner = runCommandGate,
  } = options;

  const plan = planRun(definitions, { changed, only, inherited });
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const startedMs = now();
  /** @type {Map<string, GateEntry['status']>} */
  const statuses = new Map();
  /** @type {GateEntry[]} */
  const gates = [];

  for (const item of plan) {
    const definition = byId.get(item.id);
    if (definition === undefined) throw new Error(`гейт ${item.id} отсутствует в определениях`);

    if (item.decision === 'inherit') {
      const previous = inherited[definition.id];
      const entry = makeEntry(definition, {
        status: previous?.status ?? 'not_run',
        exit: previous?.exit ?? null,
        duration_s: previous?.duration_s ?? 0,
        log: previous?.log ?? null,
        reason: previous?.reason ?? null,
      });
      gates.push(entry);
      statuses.set(entry.id, entry.status);
      continue;
    }

    if (item.decision === 'skip') {
      const entry = makeEntry(definition, { status: 'skipped', reason: item.reason });
      gates.push(entry);
      statuses.set(entry.id, entry.status);
      continue;
    }

    const blocker = definition.dependsOn.find((id) => BLOCKING_STATUSES.includes(statuses.get(id)));
    if (blocker !== undefined) {
      const entry = makeEntry(definition, { status: 'not_run', reason: `blocked_by:${blocker}` });
      gates.push(entry);
      statuses.set(entry.id, entry.status);
      continue;
    }

    const entry = await executeGate(definition, {
      dir,
      root,
      added,
      iteration,
      timeouts,
      graceMs,
      now,
      runner,
    });
    gates.push(entry);
    statuses.set(entry.id, entry.status);
  }

  return { started_at: new Date(startedMs).toISOString(), gates };
}

/**
 * Полный sha базы для диффа и документа. `--base` может быть именем ссылки (`main`), но
 * `base_sha` в `gates.<n>.json` принимается только как полный sha (Приложение A), поэтому
 * ссылка резолвится через `git rev-parse` до запуска гейтов. Недопустимая или
 * несуществующая ссылка — ошибка использования: CLI вернёт 2 и документ не запишет.
 * @param {{ base: string, cwd?: string }} options
 * @returns {string}
 */
export function resolveBaseSha({ base, cwd = repoRoot() }) {
  if (!isText(base)) {
    throw new Error(`base: ожидается sha или имя ссылки, получено ${JSON.stringify(base)}`);
  }
  /** @type {string} */
  let sha;
  try {
    sha = baseSha({ branch: base, cwd });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`base: ссылка не резолвится в sha (${base}): ${reason}`, { cause: error });
  }
  if (!FULL_SHA.test(sha)) {
    throw new Error(`base: ожидается полный sha (40 hex), получено ${JSON.stringify(sha)}`);
  }
  return sha;
}

/**
 * Разбирает аргументы командной строки. Любой мусор — ошибка использования (код 2).
 * `--base` здесь не резолвится: разбор остаётся чистым, резолв — `resolveBaseSha`.
 * @param {string[]} argv
 * @returns {{ dir: string|null, only: string[]|null, base: string|null }}
 */
export function parseArgs(argv) {
  /** @type {string|null} */
  let dir = null;
  /** @type {string[]|null} */
  let only = null;
  /** @type {string|null} */
  let base = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === '--dir') {
      if (!isText(value) || value.startsWith('--')) {
        throw new Error('--dir: ожидается путь к каталогу цикла');
      }
      dir = value;
      index += 1;
      continue;
    }
    if (arg === '--only') {
      if (!isText(value) || value.startsWith('--')) {
        throw new Error('--only: ожидается список id через запятую');
      }
      only = parseOnly(value);
      index += 1;
      continue;
    }
    if (arg === '--base') {
      if (!isText(value) || value.startsWith('--')) {
        throw new Error('--base: ожидается sha или имя ссылки');
      }
      base = value;
      index += 1;
      continue;
    }
    throw new Error(`неизвестный аргумент: ${arg}`);
  }

  return { dir, only, base };
}

/**
 * Разбор `--only`: только известные id, в порядке таблицы §5.5 (порядок аргумента не
 * влияет на прогон). Неизвестный или пустой id — ошибка использования.
 * @param {string} value
 * @returns {string[]}
 */
function parseOnly(value) {
  const ids = value.split(',').map((id) => id.trim());
  if (ids.some((id) => id === '')) {
    throw new Error(`--only: пустой id в списке ${JSON.stringify(value)}`);
  }
  const known = new Set(GATES.map((gate) => gate.id));
  for (const id of ids) {
    if (!known.has(id)) throw new Error(`--only: неизвестный гейт ${JSON.stringify(id)}`);
  }
  return GATES.filter((gate) => ids.includes(gate.id)).map((gate) => gate.id);
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
 * Читает обязательный JSON-артефакт и проверяет схему. Отсутствие или порча `state.json`
 * и прежнего `gates.<n>.json` при `--only` — отказ (код 2).
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
 * Прежние записи гейтов по id для наследования при `--only`. Нет файла — наследовать
 * нечего (`not_run` без причины, п. 1 уточнений); битый или невалидный файл — отказ.
 * @param {string} file путь `gates.<n>.json`
 * @param {string} label имя артефакта для сообщения
 * @returns {Record<string, GateEntry>}
 */
function previousGates(file, label) {
  if (!existsSync(file)) return {};

  const doc = readRequiredJson(file, validateGates, label);
  /** @type {Record<string, GateEntry>} */
  const byId = {};
  for (const entry of doc.gates) byId[entry.id] = entry;
  return byId;
}

/**
 * Код выхода по документу гейтов (§5.5): `0` — обязательных `fail` нет, `1` — есть.
 * Код `2` ставит `main` при любой ошибке использования или внутренней ошибке.
 * @param {{ gates: GateEntry[] }} doc
 * @returns {0|1}
 */
export function exitCode(doc) {
  return doc.gates.some((entry) => entry.required && entry.status === 'fail') ? 1 : 0;
}

/**
 * Точка входа CLI. Единственный вывод — строка JSON в stdout; `gates.<n>.json` пишется
 * только после успешного прогона (включая прогон с `fail`-гейтами).
 * @returns {Promise<void>}
 */
async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const root = repoRoot();
    const dir = args.dir === null ? findActiveCycle() : resolve(args.dir);

    const state = readRequiredJson(join(dir, FIXED_NAMES.state), validateState, FIXED_NAMES.state);
    const iteration = state.iteration;
    // `--base` переопределяет `state.base_sha`; имя ссылки резолвится в полный sha до
    // диффа: в `base_sha` документа `main` недопустим (Приложение A).
    const base = resolveBaseSha({ base: args.base ?? state.base_sha, cwd: root });
    const head = baseSha({ branch: HEAD_REV, cwd: root });

    // §4: untracked-файлы делаются видимыми до диффа. Без этого новые файлы (включая сам
    // скрипт) не попадают ни в условия гейтов, ни в `secrets_scan`.
    intentToAddUntracked({ cwd: root });
    const changed = changedFiles(base, { cwd: root });
    const added = addedLinesByFile(diffFromBase(base, { cwd: root }));

    const names = iterNames(iteration);
    const gatesFile = join(dir, names.gates);
    const inherited = args.only === null ? {} : previousGates(gatesFile, names.gates);

    const run = await runGates({
      definitions: GATES,
      changed,
      added,
      only: args.only,
      inherited,
      iteration,
      dir,
      root,
    });
    // `base_sha` в документе — разрешённый полный sha базы, от которой фактически
    // считался дифф (`--base` или `state.base_sha`): по нему `cycle-evidence`
    // пересобирает пакет.
    const doc = { iteration, base_sha: base, head, ...run };

    const checked = validateGates(doc);
    if (!checked.ok) {
      throw new Error(`${names.gates}: схема нарушена:\n${checked.errors.join('\n')}`);
    }

    const normalized = normalizeDoc(doc);
    writeJsonAtomic(gatesFile, normalized, { serialize: serializeArtifact });
    process.stdout.write(`${JSON.stringify(normalized)}\n`);
    process.exitCode = exitCode(normalized);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cycle-gates: ${message}\n`);
    process.exitCode = 2;
  }
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
