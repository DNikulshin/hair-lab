import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { claimStaleFile, mandatoryGatesGreen, TRANSITIONS } from './cycle-state.mjs';
import { validateEscalation, validateState } from './lib/cycle/validate.mjs';

/** Путь к CLI: тесты запускают его как отдельный процесс. */
const SCRIPT = fileURLToPath(new URL('./cycle-state.mjs', import.meta.url));

/**
 * Этапы автомата (Приложение A). Список дублируется здесь намеренно: тест таблицы §5.3
 * должен проверять ровно 13×13 комбинаций, не завися от внутренностей модуля.
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

/** Терминальные этапы: мутации запрещены. */
const TERMINAL = Object.freeze(['DONE', 'ESCALATED']);

/**
 * Независимый литерал допустимых рёбер из таблицы §5.3 (`docs/orchestrator-core.md`).
 * Намеренно не выводится из `TRANSITIONS`: иначе тест проверял бы таблицу саму собой.
 * `DONE` и `ESCALATED` терминальны — исходящих рёбер нет.
 */
const EXPECTED_TRANSITIONS = Object.freeze({
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
 * Канонический вид значения (глубокая сортировка ключей) — независимая от модуля
 * реализация: нужна для проверки `digest` и детерминизма маркера решения.
 * @param {unknown} value
 * @returns {unknown}
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonical(/** @type {Record<string, any>} */ (value)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * `sha256` канонического JSON — ожидаемый `applied_decision.digest`.
 * @param {unknown} value
 * @returns {string}
 */
function digestOf(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/** Фиксированное время тестов: детерминизм и никакого «сейчас» в артефактах. */
const NOW = '2026-11-16T09:00:00Z';
const LATER = '2026-11-16T10:30:00Z';

/** Имя каталога цикла в тестах — как у настоящего цикла T6. */
const CYCLE_NAME = '2026-11-16-157-cycle-state';

/**
 * Запускает git в тестовом репозитории; ошибка — падение теста.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string} stdout без краевых переводов строки
 */
function gitRun(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Временный git-репозиторий с одним коммитом в `main`. `.pi/artifacts/` в `.gitignore` —
 * как в рабочем репозитории. Идентичность фиктивная: настоящие имя и адрес не нужны (§4, ПДн).
 * @param {import('node:test').TestContext} t
 * @returns {{ root: string, baseSha: string }}
 */
function makeRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'hair-lab-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const init = spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(init.status, 0, `git init: ${init.stderr}`);

  gitRun(root, ['config', 'user.name', 'Тестовый агент']);
  gitRun(root, ['config', 'user.email', 'test@example.invalid']);
  gitRun(root, ['config', 'commit.gpgsign', 'false']);

  writeFileSync(join(root, '.gitignore'), '.pi/artifacts/\n');
  writeFileSync(join(root, 'tracked.txt'), 'base\n');
  gitRun(root, ['add', '.gitignore', 'tracked.txt']);
  gitRun(root, ['commit', '--quiet', '-m', 'база']);

  return { root, baseSha: gitRun(root, ['rev-parse', 'HEAD']) };
}

/**
 * `state.json` тестового цикла в форме Приложения A. `history` закрыт: тесты переходов
 * не должны спотыкаться о «сначала finish».
 * @param {string} baseSha
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, any>}
 */
function stateDoc(baseSha, overrides = {}) {
  return {
    issue: 157,
    slug: 'cycle-state',
    branch: 'chore/157-cycle-state',
    base_sha: baseSha,
    iteration: 1,
    max_iterations: 2,
    stage: 'INIT',
    stage_status: 'done',
    criteria_source: 'issue',
    retries: { REVIEW: 0, EVALUATE: 0, evidence: 0 },
    owner_approved: false,
    models: { plan: 'vendor/plan', code: 'vendor/code', review: 'vendor/review' },
    history: [
      {
        stage: 'INIT',
        iteration: 1,
        started_at: NOW,
        finished_at: NOW,
        status: 'done',
      },
    ],
    escalation: null,
    applied_decision: null,
    started_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

/**
 * Запись этапа в `history[]`.
 * @param {string} stage
 * @param {'done'|'error'|'running'} status
 * @param {{ iteration?: number, finished?: boolean }} [options]
 * @returns {Record<string, unknown>}
 */
function historyEntry(stage, status, { iteration = 1, finished = true } = {}) {
  return {
    stage,
    iteration,
    started_at: NOW,
    finished_at: finished && status !== 'running' ? NOW : null,
    status,
  };
}

/**
 * `decision.<n>.json` в форме §5.6.
 * @param {string} action
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function decisionDoc(action, overrides = {}) {
  return {
    iteration: 1,
    action,
    retry_stage: null,
    acquire: [],
    reasons: [],
    rework_items: [],
    unverified: [],
    downgraded: [],
    counts: {},
    unresolved_refs: 0,
    ...overrides,
  };
}

/**
 * Запись гейта в форме `gates.<n>.json`.
 * @param {string} id
 * @param {'pass'|'fail'|'skipped'|'not_run'} status
 * @param {string|null} [reason]
 * @returns {Record<string, unknown>}
 */
function gate(id, status, reason = null) {
  return {
    id,
    cmd: `pnpm ${id}`,
    required: true,
    status,
    exit: status === 'pass' ? 0 : null,
    duration_s: 1,
    log: null,
    reason,
  };
}

/**
 * Документ `gates.<n>.json`.
 * @param {string} baseSha
 * @param {Record<string, unknown>[]} entries
 * @param {number} [iteration]
 * @returns {Record<string, unknown>}
 */
function gatesDoc(baseSha, entries, iteration = 1) {
  return {
    iteration,
    base_sha: baseSha,
    head: 'HEAD',
    started_at: NOW,
    gates: entries,
  };
}

/**
 * Каталог цикла с `state.json` и дополнительными файлами.
 * @param {string} root
 * @param {{
 *   state: Record<string, unknown>,
 *   name?: string,
 *   files?: Record<string, string>,
 * }} options
 * @returns {string} каталог цикла
 */
function makeCycle(root, { state, name = CYCLE_NAME, files = {} }) {
  const dir = join(root, '.pi', 'artifacts', name);
  mkdirSync(dir, { recursive: true });
  writeState(dir, state);

  for (const [file, text] of Object.entries(files)) {
    const target = join(dir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }

  return dir;
}

/**
 * Каноническая (pretty) запись `state.json`; возвращает текст для сравнения байт-в-байт.
 * @param {string} dir
 * @param {Record<string, unknown>} state
 * @returns {string}
 */
function writeState(dir, state) {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  writeFileSync(join(dir, 'state.json'), text);
  return text;
}

/**
 * Текст `state.json`.
 * @param {string} dir
 * @returns {string}
 */
function stateText(dir) {
  return readFileSync(join(dir, 'state.json'), 'utf8');
}

/**
 * Разобранный `state.json`.
 * @param {string} dir
 * @returns {Record<string, any>}
 */
function stateJson(dir) {
  return JSON.parse(stateText(dir));
}

/**
 * Запускает CLI как отдельный процесс.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runCli(cwd, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

/**
 * Единственная строка JSON из stdout CLI.
 * @param {{ stdout: string }} result
 * @returns {any}
 */
function stdoutJson(result) {
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `ожидалась одна строка JSON, получено: ${result.stdout}`);
  return JSON.parse(lines[0]);
}

/**
 * Жив ли процесс.
 * @param {number} pid
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

/**
 * Асинхронный `lock`: нужен одновременный старт двух процессов (spawnSync запускает их
 * по очереди и гонки не создаёт).
 * @param {string} cwd
 * @returns {Promise<{ status: number|null, stdout: string, stderr: string }>}
 */
function spawnLock(cwd) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, 'lock', '--slug', 'cycle-state', '--now', NOW], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

/**
 * Pid гарантированно завершённого процесса: короткоживущий потомок уже вышел, а `spawnSync`
 * дождался его конца.
 * @returns {number}
 */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.equal(child.status, 0);
  assert.equal(isAlive(child.pid), false, 'процесс должен быть завершён');
  return child.pid;
}

describe('cycle-state: init', () => {
  test('создаёт state.json, базу из main и модели из frontmatter агентов', (t) => {
    const { root, baseSha } = makeRepo(t);
    mkdirSync(join(root, '.pi', 'agents'), { recursive: true });
    writeFileSync(
      join(root, '.pi', 'agents', 'plan.md'),
      '---\nname: plan\nmodel: vendor/plan\nthinking: high\ntools: read\n---\n\nПлан.\n',
    );
    writeFileSync(
      join(root, '.pi', 'agents', 'code.md'),
      '---\nname: code\nmodel: "vendor/code"\nthinking: low\ntools: read, edit\n---\n\nКод.\n',
    );
    writeFileSync(
      join(root, '.pi', 'agents', 'review.md'),
      '---\nname: review\nmodel: vendor/review\nthinking: medium\ntools: read\n---\n\nРевью.\n',
    );

    const result = runCli(root, [
      'init',
      '--issue',
      '157',
      '--slug',
      'cycle-state',
      '--branch',
      'chore/157-cycle-state',
      '--now',
      NOW,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const dir = join(root, '.pi', 'artifacts', CYCLE_NAME);
    const state = stateJson(dir);
    assert.equal(validateState(state).ok, true, validateState(state).errors.join('\n'));
    assert.deepEqual(state, {
      applied_decision: null,
      base_sha: baseSha,
      branch: 'chore/157-cycle-state',
      criteria_source: 'issue',
      escalation: null,
      history: [{ stage: 'INIT', iteration: 1, started_at: NOW, finished_at: NOW, status: 'done' }],
      issue: 157,
      iteration: 1,
      max_iterations: 2,
      models: { plan: 'vendor/plan', code: 'vendor/code', review: 'vendor/review' },
      owner_approved: false,
      retries: { REVIEW: 0, EVALUATE: 0, evidence: 0 },
      slug: 'cycle-state',
      stage: 'INIT',
      stage_status: 'done',
      started_at: NOW,
      updated_at: NOW,
    });
    // `evaluate` появится в T7: пока файла нет, ключ опускается.
    assert.equal(Object.hasOwn(state.models, 'evaluate'), false);
    assert.deepEqual(stdoutJson(result), state);
  });

  test('--date и --max-iterations меняют имя каталога и лимит проходов', (t) => {
    const { root } = makeRepo(t);

    const result = runCli(root, [
      'init',
      '--issue',
      '157',
      '--slug',
      'cycle-state',
      '--branch',
      'chore/157-cycle-state',
      '--date',
      '2026-01-02',
      '--max-iterations',
      '3',
      '--now',
      NOW,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const state = stateJson(join(root, '.pi', 'artifacts', '2026-01-02-157-cycle-state'));
    assert.equal(state.max_iterations, 3);
    assert.equal(state.started_at, NOW);
  });

  test('повторный init — код 3, файл не меняется', (t) => {
    const { root } = makeRepo(t);
    const args = [
      'init',
      '--issue',
      '157',
      '--slug',
      'cycle-state',
      '--branch',
      'chore/157-cycle-state',
      '--now',
      NOW,
    ];
    assert.equal(runCli(root, args).status, 0);

    const dir = join(root, '.pi', 'artifacts', CYCLE_NAME);
    const before = stateText(dir);
    const repeated = runCli(root, [...args.slice(0, -2), '--now', LATER]);

    assert.equal(repeated.status, 3);
    assert.equal(stateText(dir), before);
  });

  test('без --issue, --slug и --branch — код 2 и каталог не создаётся', (t) => {
    const { root } = makeRepo(t);

    const result = runCli(root, ['init', '--issue', '157', '--now', NOW]);
    assert.equal(result.status, 2);
    assert.equal(existsSync(join(root, '.pi', 'artifacts', CYCLE_NAME, 'state.json')), false);
  });
});

describe('cycle-state: get', () => {
  test('печатает состояние целиком и значение поля', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycle(root, {
      state: stateDoc(baseSha, { stage: 'CODE', stage_status: 'done' }),
    });

    const all = runCli(root, ['get', '--dir', dir]);
    assert.equal(all.status, 0, all.stderr);
    assert.deepEqual(stdoutJson(all), stateJson(dir));

    const field = runCli(root, ['get', '--dir', dir, '--field', 'stage']);
    assert.equal(field.status, 0);
    assert.equal(stdoutJson(field), 'CODE');

    const missing = runCli(root, ['get', '--dir', dir, '--field', 'nope']);
    assert.equal(missing.status, 2);
  });

  test('работает на терминальном этапе и без --dir ищет активный цикл', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycle(root, {
      state: stateDoc(baseSha, { stage: 'DONE', stage_status: 'done' }),
    });

    const terminal = runCli(root, ['get', '--dir', dir, '--field', 'stage']);
    assert.equal(terminal.status, 0, terminal.stderr);
    assert.equal(stdoutJson(terminal), 'DONE');

    // Активный цикл ищется по умолчанию: DONE активным не считается (paths.mjs).
    const active = runCli(root, ['get']);
    assert.equal(active.status, 2);
  });

  test('битый state.json — код 2 и файл не перезаписывается', (t) => {
    const { root } = makeRepo(t);
    const dir = join(root, '.pi', 'artifacts', CYCLE_NAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), '{"stage":\n');

    const result = runCli(root, ['get', '--dir', dir]);
    assert.equal(result.status, 2);
    assert.equal(stateText(dir), '{"stage":\n');
  });
});

describe('cycle-state: переходы §5.3', () => {
  test('TRANSITIONS точно совпадает с независимым литералом таблицы §5.3', () => {
    assert.deepEqual(
      Object.keys(TRANSITIONS).sort(),
      Object.keys(EXPECTED_TRANSITIONS).sort(),
      'набор исходных этапов должен совпадать с таблицей',
    );

    for (const from of Object.keys(EXPECTED_TRANSITIONS)) {
      const actual = TRANSITIONS[from] ?? [];
      for (const to of EXPECTED_TRANSITIONS[from]) {
        assert.ok(actual.includes(to), `${from} → ${to} есть в таблице §5.3, но нет в TRANSITIONS`);
      }
      for (const to of actual) {
        assert.ok(
          EXPECTED_TRANSITIONS[from].includes(to),
          `${from} → ${to} есть в TRANSITIONS, но нет в таблице §5.3`,
        );
      }
      assert.deepEqual([...actual].sort(), [...EXPECTED_TRANSITIONS[from]].sort(), from);
    }

    for (const from of Object.keys(TRANSITIONS)) {
      assert.ok(
        Object.hasOwn(EXPECTED_TRANSITIONS, from),
        `${from} есть в TRANSITIONS, но в таблице §5.3 исходящих рёбер нет`,
      );
    }
  });

  test('13×13: допустимые рёбра дают 0, остальные — 3', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = join(root, '.pi', 'artifacts', CYCLE_NAME);
    mkdirSync(dir, { recursive: true });

    // Предусловия этапов выполнены для любого стартового этапа: `→ DECIDE` требует файлы
    // ревью и оценки, `→ PR` — решение с PROCEED.
    writeFileSync(join(dir, 'review.1.md'), '# Ревью\n');
    writeFileSync(join(dir, 'evaluation.1.md'), '# Оценка\n');
    writeFileSync(
      join(dir, 'decision.1.json'),
      `${JSON.stringify(decisionDoc('PROCEED'), null, 2)}\n`,
    );

    let allowed = 0;
    let forbidden = 0;

    for (const from of STAGES) {
      for (const to of STAGES) {
        const before = writeState(dir, stateDoc(baseSha, { stage: from, stage_status: 'done' }));
        const result = runCli(root, ['advance', '--dir', dir, '--to', to, '--now', LATER]);
        const expected =
          EXPECTED_TRANSITIONS[from]?.includes(to) === true && to !== 'ESCALATED' ? 0 : 3;

        assert.equal(
          result.status,
          expected,
          `${from} → ${to}: ожидался код ${expected}, получен ${result.status} (${result.stderr.trim()})`,
        );

        if (expected === 0) {
          allowed += 1;
          const state = stateJson(dir);
          assert.equal(validateState(state).ok, true, validateState(state).errors.join('\n'));
          assert.equal(state.stage, to);
          assert.equal(state.stage_status, 'running');
        } else {
          forbidden += 1;
          assert.equal(stateText(dir), before, `${from} → ${to}: файл изменился при отказе`);
        }
      }
    }

    // Таблица §5.3 без переходов в ESCALATED (они только через `escalate`):
    // INIT 1 + PLAN 1 + CODE 1 + GATES 2 + QA_WEB 1 + REVIEW 2 + EVALUATE 2 + DECIDE 5 +
    // REWORK 1 + ACQUIRE_EVIDENCE 2 + PR 1 = 19.
    assert.equal(allowed, 19, 'в таблице §5.3 девятнадцать рёбер advance');
    assert.equal(forbidden, STAGES.length * STAGES.length - allowed);
  });

  test('→ ESCALATED через advance запрещён: только escalate', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycle(root, { state: stateDoc(baseSha, { stage: 'INIT' }) });

    const result = runCli(root, ['advance', '--dir', dir, '--to', 'ESCALATED', '--now', LATER]);
    assert.equal(result.status, 3);
  });
});

describe('cycle-state: защиты переходов', () => {
  test('→ DECIDE требует review.<n>.md и evaluation.<n>.md текущей итерации', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycle(root, { state: stateDoc(baseSha, { stage: 'REVIEW' }) });

    const without = runCli(root, ['advance', '--dir', dir, '--to', 'DECIDE', '--now', LATER]);
    assert.equal(without.status, 3);

    writeFileSync(join(dir, 'review.1.md'), '# Ревью\n');
    const onlyReview = runCli(root, ['advance', '--dir', dir, '--to', 'DECIDE', '--now', LATER]);
    assert.equal(onlyReview.status, 3);

    writeFileSync(join(dir, 'evaluation.1.md'), '# Оценка\n');
    const both = runCli(root, ['advance', '--dir', dir, '--to', 'DECIDE', '--now', LATER]);
    assert.equal(both.status, 0, both.stderr);
  });

  test('→ PR только с decision PROCEED или PROCEED_WITH_UNVERIFIED', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycle(root, { state: stateDoc(baseSha, { stage: 'DECIDE' }) });
    const cases = [
      { decision: null, code: 3 },
      { decision: decisionDoc('REWORK'), code: 3 },
      { decision: decisionDoc('ACQUIRE_EVIDENCE'), code: 3 },
      { decision: decisionDoc('PROCEED'), code: 0 },
      { decision: decisionDoc('PROCEED_WITH_UNVERIFIED'), code: 0 },
    ];

    for (const item of cases) {
      writeState(dir, stateDoc(baseSha, { stage: 'DECIDE' }));
      if (item.decision === null) {
        if (existsSync(join(dir, 'decision.1.json'))) rmSync(join(dir, 'decision.1.json'));
      } else {
        writeFileSync(join(dir, 'decision.1.json'), `${JSON.stringify(item.decision, null, 2)}\n`);
      }

      const result = runCli(root, ['advance', '--dir', dir, '--to', 'PR', '--now', LATER]);
      assert.equal(result.status, item.code, `${JSON.stringify(item.decision)}: ${result.stderr}`);
    }
  });

  test('REWORK → CODE: инкремент и граница max_iterations', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycle(root, {
      state: stateDoc(baseSha, { stage: 'REWORK', iteration: 1, max_iterations: 2 }),
    });

    const first = runCli(root, ['advance', '--dir', dir, '--to', 'CODE', '--now', LATER]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(stateJson(dir).iteration, 2);
    assert.equal(stateJson(dir).owner_approved, false);

    // На лимите без флага — отказ, файл не меняется.
    const atLimit = stateDoc(baseSha, { stage: 'REWORK', iteration: 2, max_iterations: 2 });
    const before = writeState(dir, atLimit);
    const refused = runCli(root, ['advance', '--dir', dir, '--to', 'CODE', '--now', LATER]);
    assert.equal(refused.status, 3);
    assert.equal(stateText(dir), before);

    // С --owner-approved переход разрешён, флаг сохраняется в состоянии.
    const approved = runCli(root, [
      'advance',
      '--dir',
      dir,
      '--to',
      'CODE',
      '--owner-approved',
      '--now',
      LATER,
    ]);
    assert.equal(approved.status, 0, approved.stderr);
    const state = stateJson(dir);
    assert.equal(state.iteration, 3);
    assert.equal(state.owner_approved, true);
    assert.equal(validateState(state).ok, true, validateState(state).errors.join('\n'));
  });

  test('открытый этап требует finish, повторный вход — только после error', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycle(root, {
      state: stateDoc(baseSha, { stage: 'PLAN', stage_status: 'done' }),
    });

    assert.equal(runCli(root, ['advance', '--dir', dir, '--to', 'PLAN', '--now', LATER]).status, 3);
    assert.equal(runCli(root, ['advance', '--dir', dir, '--to', 'CODE', '--now', LATER]).status, 0);
    const running = stateText(dir);
    assert.equal(runCli(root, ['advance', '--dir', dir, '--to', 'CODE', '--now', LATER]).status, 3);
    assert.equal(stateText(dir), running);

    // Сбой этапа: finish --status error, затем повторный вход в тот же этап.
    assert.equal(
      runCli(root, ['finish', '--dir', dir, '--stage', 'CODE', '--status', 'error', '--now', LATER])
        .status,
      0,
    );
    const state = stateJson(dir);
    assert.equal(state.stage_status, 'error');
    assert.equal(state.history.at(-1).status, 'error');

    const reentry = runCli(root, ['advance', '--dir', dir, '--to', 'CODE', '--now', LATER]);
    assert.equal(reentry.status, 0, reentry.stderr);
    assert.equal(stateJson(dir).stage_status, 'running');
  });

  test('терминальный этап: мутации — код 3, файл не меняется', (t) => {
    const { root, baseSha } = makeRepo(t);

    for (const stage of TERMINAL) {
      const dir = makeCycle(root, {
        state: stateDoc(baseSha, { stage, stage_status: 'done' }),
        name: `${CYCLE_NAME}-${stage.toLowerCase()}`,
      });
      const before = stateText(dir);

      const commands = [
        ['advance', '--dir', dir, '--to', 'PLAN', '--now', LATER],
        ['finish', '--dir', dir, '--stage', stage, '--status', 'done', '--now', LATER],
        ['escalate', '--dir', dir, '--reason', 'budget', '--now', LATER],
        ['advance', '--dir', dir, '--to', 'DONE', '--now', LATER],
      ];
      for (const command of commands) {
        assert.equal(runCli(root, command).status, 3, `${stage}: ${command.join(' ')}`);
      }
      assert.equal(stateText(dir), before);
    }
  });

  test('опечатка в стадии и мусор в аргументах — код 2', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycle(root, { state: stateDoc(baseSha) });
    const before = stateText(dir);

    const cases = [
      ['advance', '--dir', dir, '--to', 'PLAN2'],
      ['finish', '--dir', dir, '--stage', 'PLAN', '--status', 'success'],
      ['advance', '--dir', dir],
      ['advance', '--dir', dir, '--to', 'PLAN', '--now', 'вчера'],
      ['advance', '--dir', dir, '--to', 'PLAN', '--field', 'stage'],
      ['init', '--issue', '0', '--slug', 'cycle-state', '--branch', 'main'],
      ['get', '--dir'],
      ['nope'],
      [],
    ];

    for (const args of cases) {
      assert.equal(runCli(root, args).status, 2, `аргументы: ${args.join(' ')}`);
    }
    assert.equal(stateText(dir), before);
  });
});

describe('cycle-state: finish', () => {
  test('закрывает открытую запись, маскирует --detail', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycle(root, {
      state: stateDoc(baseSha, {
        stage: 'QA_WEB',
        stage_status: 'running',
        history: [
          historyEntry('INIT', 'done'),
          historyEntry('QA_WEB', 'running', { finished: false }),
        ],
      }),
    });

    const result = runCli(root, [
      'finish',
      '--dir',
      dir,
      '--stage',
      'QA_WEB',
      '--status',
      'error',
      '--detail',
      'почта test@example.invalid, тел. +79990000000',
      '--now',
      LATER,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const state = stateJson(dir);
    assert.equal(state.stage_status, 'error');
    assert.equal(state.updated_at, LATER);
    assert.equal(state.history.at(-1).finished_at, LATER);
    assert.equal(state.history.at(-1).status, 'error');
    assert.equal(
      state.history.at(-1).detail,
      'почта [email], тел. [phone]',
      'свободный текст маскируется (§5.4)',
    );
    assert.equal(validateState(state).ok, true);
  });

  test('чужой этап и отсутствие открытой записи — код 3', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycle(root, {
      state: stateDoc(baseSha, {
        stage: 'GATES',
        stage_status: 'running',
        history: [historyEntry('GATES', 'running', { finished: false })],
      }),
    });

    assert.equal(
      runCli(root, ['finish', '--dir', dir, '--stage', 'PLAN', '--status', 'done', '--now', LATER])
        .status,
      3,
    );
    assert.equal(
      runCli(root, ['finish', '--dir', dir, '--stage', 'GATES', '--status', 'done', '--now', LATER])
        .status,
      0,
    );

    const before = stateText(dir);
    const twice = runCli(root, [
      'finish',
      '--dir',
      dir,
      '--stage',
      'GATES',
      '--status',
      'done',
      '--now',
      LATER,
    ]);
    assert.equal(twice.status, 3);
    assert.equal(stateText(dir), before);
  });
});

describe('cycle-state: apply-decision', () => {
  /**
   * Каталог цикла в DECIDE с решением `decision.1.json`.
   * @param {import('node:test').TestNode} t
   * @param {Record<string, unknown>} decision
   * @param {{ state?: Record<string, unknown> }} [options]
   * @returns {{ root: string, dir: string, baseSha: string }}
   */
  function decideCycle(t, decision, { state = {} } = {}) {
    const repo = makeRepo(t);
    const dir = makeCycle(repo.root, {
      state: stateDoc(repo.baseSha, {
        stage: 'DECIDE',
        stage_status: 'done',
        history: [historyEntry('INIT', 'done'), historyEntry('DECIDE', 'done')],
        ...state,
      }),
      files: { 'decision.1.json': `${JSON.stringify(decision, null, 2)}\n` },
    });
    return { ...repo, dir };
  }

  test('RETRY_STAGE: счётчик этапа растёт один раз', (t) => {
    const { root, dir } = decideCycle(t, decisionDoc('RETRY_STAGE', { retry_stage: 'REVIEW' }));

    const first = runCli(root, ['apply-decision', '--dir', dir, '--now', LATER]);
    assert.equal(first.status, 0, first.stderr);

    const after = stateJson(dir);
    assert.equal(after.stage, 'REVIEW');
    assert.equal(after.stage_status, 'running');
    assert.equal(after.retries.REVIEW, 1);
    assert.equal(after.retries.EVALUATE, 0);
    assert.deepEqual(after.applied_decision, {
      iteration: 1,
      action: 'RETRY_STAGE',
      retry_stage: 'REVIEW',
      digest: digestOf(decisionDoc('RETRY_STAGE', { retry_stage: 'REVIEW' })),
    });

    const before = stateText(dir);
    const second = runCli(root, ['apply-decision', '--dir', dir, '--now', '2026-11-16T11:00:00Z']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(stateText(dir), before, 'идемпотентность: файл не перезаписывается');
    assert.equal(stateJson(dir).retries.REVIEW, 1, 'счётчик не растёт дважды');
  });

  test('RETRY_STAGE для EVALUATE', (t) => {
    const { root, dir } = decideCycle(t, decisionDoc('RETRY_STAGE', { retry_stage: 'EVALUATE' }));

    assert.equal(runCli(root, ['apply-decision', '--dir', dir, '--now', LATER]).status, 0);
    const state = stateJson(dir);
    assert.equal(state.stage, 'EVALUATE');
    assert.equal(state.retries.EVALUATE, 1);
  });

  test('ACQUIRE_EVIDENCE: счётчик evidence растёт один раз', (t) => {
    const { root, dir } = decideCycle(t, decisionDoc('ACQUIRE_EVIDENCE'));

    assert.equal(runCli(root, ['apply-decision', '--dir', dir, '--now', LATER]).status, 0);
    assert.equal(stateJson(dir).stage, 'ACQUIRE_EVIDENCE');
    assert.equal(stateJson(dir).retries.evidence, 1);

    assert.equal(runCli(root, ['apply-decision', '--dir', dir, '--now', LATER]).status, 0);
    assert.equal(stateJson(dir).retries.evidence, 1);
  });

  test('REWORK: переход без инкремента iteration (инкремент на ребре REWORK → CODE)', (t) => {
    const { root, dir } = decideCycle(t, decisionDoc('REWORK'));

    assert.equal(runCli(root, ['apply-decision', '--dir', dir, '--now', LATER]).status, 0);
    const state = stateJson(dir);
    assert.equal(state.stage, 'REWORK');
    assert.equal(state.iteration, 1, 'iteration меняется только в advance REWORK → CODE');

    assert.equal(runCli(root, ['apply-decision', '--dir', dir, '--now', LATER]).status, 0);
    assert.equal(stateJson(dir).iteration, 1);
  });

  test('PROCEED и PROCEED_WITH_UNVERIFIED ведут в PR', (t) => {
    for (const action of ['PROCEED', 'PROCEED_WITH_UNVERIFIED']) {
      const { root, dir } = decideCycle(t, decisionDoc(action));
      assert.equal(runCli(root, ['apply-decision', '--dir', dir, '--now', LATER]).status, 0);
      assert.equal(stateJson(dir).stage, 'PR', action);
      assert.equal(stateJson(dir).iteration, 1);
    }
  });

  test('ESCALATE пишет escalation.json и завершает цикл идемпотентно', (t) => {
    const { root, dir, baseSha } = decideCycle(
      t,
      decisionDoc('ESCALATE', {
        reasons: ['gate:lint: fail', 'escalate:iteration_limit'],
        rework_items: ['gate:lint [fail] — обязательный гейт не прошёл'],
        unverified: ['gate:test_int not_run (no_database)'],
      }),
      {
        state: {
          history: [
            historyEntry('INIT', 'done'),
            historyEntry('CODE', 'done'),
            historyEntry('DECIDE', 'running', { finished: false }),
          ],
        },
      },
    );
    writeFileSync(
      join(dir, 'gates.1.json'),
      `${JSON.stringify(gatesDoc(baseSha, [gate('lint', 'pass')]), null, 2)}\n`,
    );

    const result = runCli(root, ['apply-decision', '--dir', dir, '--now', LATER]);
    assert.equal(result.status, 0, result.stderr);

    const escalation = JSON.parse(readFileSync(join(dir, 'escalation.json'), 'utf8'));
    assert.deepEqual(escalation, {
      detail: 'gate:lint: fail; escalate:iteration_limit',
      draft_pr_allowed: true,
      open_items: [
        'gate:lint [fail] — обязательный гейт не прошёл',
        'gate:test_int not_run (no_database)',
      ],
      reason: 'iteration_limit',
    });
    assert.equal(validateEscalation(escalation).ok, true);

    const state = stateJson(dir);
    assert.equal(state.stage, 'ESCALATED');
    assert.equal(state.stage_status, 'done');
    assert.deepEqual(state.escalation, {
      detail: 'gate:lint: fail; escalate:iteration_limit',
      draft_pr_allowed: true,
      reason: 'iteration_limit',
    });
    assert.equal(state.history.at(-2).status, 'error');
    assert.equal(state.history.at(-2).detail, 'iteration_limit');
    assert.equal(state.history.at(-1).status, 'done');
    assert.equal(validateState(state).ok, true);

    const before = stateText(dir);
    const second = runCli(root, ['apply-decision', '--dir', dir, '--now', '2026-11-16T11:00:00Z']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(stateText(dir), before);
  });

  test('изменённое решение не считается повтором: код 3 вместо молчаливого успеха', (t) => {
    const decision = decisionDoc('REWORK', { reasons: ['gate:lint: fail'] });
    const { root, dir } = decideCycle(t, decision);

    assert.equal(runCli(root, ['apply-decision', '--dir', dir, '--now', LATER]).status, 0);
    const applied = stateJson(dir);
    assert.equal(applied.stage, 'REWORK');
    assert.equal(
      applied.applied_decision.digest,
      digestOf(decision),
      'digest — sha256 канонического решения',
    );

    // Те же iteration/action/retry_stage, но другое содержимое решения (причина эскалации).
    const changed = decisionDoc('REWORK', {
      reasons: ['gate:lint: fail', 'escalate:iteration_limit'],
    });
    writeFileSync(join(dir, 'decision.1.json'), `${JSON.stringify(changed, null, 2)}\n`);

    const before = stateText(dir);
    const second = runCli(root, ['apply-decision', '--dir', dir, '--now', LATER]);
    assert.equal(second.status, 3, second.stderr);
    assert.equal(stateText(dir), before, 'новое решение не применяется вслепую');
    assert.equal(
      stateJson(dir).applied_decision.digest,
      applied.applied_decision.digest,
      'маркер не переписан',
    );
  });

  test('изменённое решение после ESCALATE: код 3, артефакты не меняются', (t) => {
    const decision = decisionDoc('ESCALATE', { reasons: ['escalate:iteration_limit'] });
    const { root, dir } = decideCycle(t, decision, {
      state: {
        history: [
          historyEntry('INIT', 'done'),
          historyEntry('CODE', 'done'),
          historyEntry('DECIDE', 'done'),
        ],
      },
    });

    assert.equal(runCli(root, ['apply-decision', '--dir', dir, '--now', LATER]).status, 0);
    const stateBefore = stateText(dir);
    const escalationBefore = readFileSync(join(dir, 'escalation.json'), 'utf8');

    writeFileSync(
      join(dir, 'decision.1.json'),
      `${JSON.stringify(decisionDoc('ESCALATE', { reasons: ['escalate:budget'] }), null, 2)}\n`,
    );
    const second = runCli(root, ['apply-decision', '--dir', dir, '--now', LATER]);
    assert.equal(second.status, 3, second.stderr);
    assert.equal(stateText(dir), stateBefore, 'терминальное состояние не меняется');
    assert.equal(readFileSync(join(dir, 'escalation.json'), 'utf8'), escalationBefore);
  });

  test('не из DECIDE — код 3; нет решения — код 2; чужая итерация — код 3', (t) => {
    const { root, baseSha } = makeRepo(t);

    const running = makeCycle(root, {
      state: stateDoc(baseSha, { stage: 'REVIEW' }),
      name: '2026-11-16-157-review',
      files: { 'decision.1.json': `${JSON.stringify(decisionDoc('REWORK'), null, 2)}\n` },
    });
    assert.equal(runCli(root, ['apply-decision', '--dir', running, '--now', LATER]).status, 3);

    const empty = makeCycle(root, {
      state: stateDoc(baseSha, { stage: 'DECIDE' }),
      name: '2026-11-16-157-empty',
    });
    assert.equal(runCli(root, ['apply-decision', '--dir', empty, '--now', LATER]).status, 2);

    const foreign = makeCycle(root, {
      state: stateDoc(baseSha, { stage: 'DECIDE' }),
      name: '2026-11-16-157-foreign',
      files: {
        'decision.1.json': `${JSON.stringify(decisionDoc('REWORK', { iteration: 2 }), null, 2)}\n`,
      },
    });
    assert.equal(runCli(root, ['apply-decision', '--dir', foreign, '--now', LATER]).status, 3);
  });
});

describe('cycle-state: escalate и draft_pr_allowed', () => {
  /** Причины, при которых draft PR допустим (R4, §9 спеки). */
  const DRAFT_REASONS = Object.freeze(['iteration_limit', 'budget', 'agent_output_invalid']);
  const ALL_REASONS = Object.freeze([
    'iteration_limit',
    'budget',
    'agent_output_invalid',
    'criteria_missing',
    'plan_ambiguous',
  ]);

  test('матрица: причина × гейты × завершённость прохода code', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = join(root, '.pi', 'artifacts', CYCLE_NAME);
    mkdirSync(dir, { recursive: true });

    /** Варианты состояния гейтов: зелёные, обязательный fail, пустой список, чужая итерация, отсутствующий файл. */
    const gatesCases = [
      {
        name: 'green',
        text: `${JSON.stringify(gatesDoc(baseSha, [gate('lint', 'pass')]), null, 2)}\n`,
      },
      {
        name: 'red',
        text: `${JSON.stringify(gatesDoc(baseSha, [gate('lint', 'fail')]), null, 2)}\n`,
      },
      {
        name: 'no_database',
        text: `${JSON.stringify(
          gatesDoc(baseSha, [gate('test_int', 'not_run', 'no_database')]),
          null,
          2,
        )}\n`,
      },
      {
        name: 'empty',
        text: `${JSON.stringify(gatesDoc(baseSha, []), null, 2)}\n`,
      },
      {
        name: 'foreign_iteration',
        text: `${JSON.stringify(gatesDoc(baseSha, [gate('lint', 'pass')], 2), null, 2)}\n`,
      },
      { name: 'missing', text: null },
    ];

    /** Гейты, при которых обязательная часть зелёная (исключение §5.6 — `no_database`). */
    const greenCases = Object.freeze(['green', 'no_database']);

    for (const reason of ALL_REASONS) {
      for (const gates of gatesCases) {
        for (const codeDone of [true, false]) {
          writeState(
            dir,
            stateDoc(baseSha, {
              stage: 'GATES',
              stage_status: 'done',
              history: [
                historyEntry('INIT', 'done'),
                historyEntry('PLAN', 'done'),
                historyEntry('CODE', codeDone ? 'done' : 'error'),
                historyEntry('GATES', 'done'),
              ],
            }),
          );
          const gatesFile = join(dir, 'gates.1.json');
          if (gates.text === null) {
            if (existsSync(gatesFile)) rmSync(gatesFile);
          } else {
            writeFileSync(gatesFile, gates.text);
          }

          const result = runCli(root, [
            'escalate',
            '--dir',
            dir,
            '--reason',
            reason,
            '--now',
            LATER,
          ]);
          assert.equal(result.status, 0, result.stderr);

          const expected =
            DRAFT_REASONS.includes(reason) && greenCases.includes(gates.name) && codeDone;
          const escalation = JSON.parse(readFileSync(join(dir, 'escalation.json'), 'utf8'));
          assert.equal(
            escalation.draft_pr_allowed,
            expected,
            `${reason}/${gates.name}/code ${codeDone ? 'done' : 'error'}`,
          );
          assert.equal(stateJson(dir).escalation.draft_pr_allowed, expected);
          assert.equal(stateJson(dir).stage, 'ESCALATED');
        }
      }
    }
  });

  test('open_items из решения текущей итерации и закрытие открытого этапа', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycle(root, {
      state: stateDoc(baseSha, {
        stage: 'PLAN',
        stage_status: 'running',
        history: [
          historyEntry('INIT', 'done'),
          historyEntry('PLAN', 'running', { finished: false }),
        ],
      }),
      files: {
        'decision.1.json': `${JSON.stringify(
          decisionDoc('REWORK', {
            rework_items: ['R1 [BLOCKER] a.mjs:1 — правка'],
            unverified: ['criteria:C2 unverified'],
          }),
          null,
          2,
        )}\n`,
      },
    });

    const result = runCli(root, [
      'escalate',
      '--dir',
      dir,
      '--reason',
      'plan_ambiguous',
      '--detail',
      'вариант A или B',
      '--now',
      LATER,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const escalation = JSON.parse(readFileSync(join(dir, 'escalation.json'), 'utf8'));
    assert.deepEqual(escalation, {
      detail: 'вариант A или B',
      draft_pr_allowed: false,
      open_items: ['R1 [BLOCKER] a.mjs:1 — правка', 'criteria:C2 unverified'],
      reason: 'plan_ambiguous',
    });

    const state = stateJson(dir);
    assert.equal(state.stage, 'ESCALATED');
    assert.equal(state.history.at(-2).stage, 'PLAN');
    assert.equal(state.history.at(-2).status, 'error');
    assert.equal(state.history.at(-2).finished_at, LATER);
    assert.equal(state.history.at(-2).detail, 'plan_ambiguous');
  });

  test('недопустимый этап и неизвестная причина — отказы без изменения файла', (t) => {
    const { root, baseSha } = makeRepo(t);

    const code = makeCycle(root, {
      state: stateDoc(baseSha, {
        stage: 'CODE',
        stage_status: 'done',
        history: [historyEntry('CODE', 'done')],
      }),
      name: '2026-11-16-157-code',
    });
    const before = stateText(code);
    assert.equal(
      runCli(root, ['escalate', '--dir', code, '--reason', 'budget', '--now', LATER]).status,
      3,
    );
    assert.equal(stateText(code), before);

    const plan = makeCycle(root, {
      state: stateDoc(baseSha, {
        stage: 'PLAN',
        stage_status: 'done',
        history: [historyEntry('PLAN', 'done')],
      }),
      name: '2026-11-16-157-plan',
    });
    const planBefore = stateText(plan);
    assert.equal(
      runCli(root, ['escalate', '--dir', plan, '--reason', 'later', '--now', LATER]).status,
      2,
    );
    assert.equal(stateText(plan), planBefore);
  });
});

describe('cycle-state: обязательные гейты зелёные (mandatoryGatesGreen)', () => {
  const sha = 'a'.repeat(40);

  /** Необязательный гейт с `fail`: он не влияет на draft PR. */
  const optionalFail = { ...gate('optional', 'fail'), required: false };

  /** Матрица §9: только `pass` и `not_run`/`no_database` считаются зелёными. */
  const cases = [
    { name: 'нет документа', doc: null, iteration: 1, expected: false },
    { name: 'пустой gates[]', doc: gatesDoc(sha, []), iteration: 1, expected: false },
    {
      name: 'обязательный pass',
      doc: gatesDoc(sha, [gate('lint', 'pass')]),
      iteration: 1,
      expected: true,
    },
    {
      name: 'обязательный fail',
      doc: gatesDoc(sha, [gate('lint', 'fail')]),
      iteration: 1,
      expected: false,
    },
    {
      name: 'обязательный not_run по no_database — не провал (§5.6)',
      doc: gatesDoc(sha, [gate('test_int', 'not_run', 'no_database')]),
      iteration: 1,
      expected: true,
    },
    {
      name: 'обязательный not_run по timeout — провал',
      doc: gatesDoc(sha, [gate('typecheck', 'not_run', 'timeout')]),
      iteration: 1,
      expected: false,
    },
    {
      name: 'обязательный not_run по blocked_by — провал',
      doc: gatesDoc(sha, [gate('test', 'not_run', 'blocked_by:contracts_build')]),
      iteration: 1,
      expected: false,
    },
    {
      name: 'обязательный skipped — провал',
      doc: gatesDoc(sha, [gate('lint_workflows', 'skipped', 'not_applicable')]),
      iteration: 1,
      expected: false,
    },
    {
      name: 'необязательный fail рядом с pass — зелёные',
      doc: gatesDoc(sha, [gate('lint', 'pass'), optionalFail]),
      iteration: 1,
      expected: true,
    },
    {
      name: 'итерация документа ≠ итерация состояния',
      doc: gatesDoc(sha, [gate('lint', 'pass')], 2),
      iteration: 1,
      expected: false,
    },
    {
      name: 'невалидный документ',
      doc: { iteration: 1, gates: [gate('lint', 'pass')] },
      iteration: 1,
      expected: false,
    },
    {
      name: 'не документ, а строка',
      doc: 'gates',
      iteration: 1,
      expected: false,
    },
  ];

  for (const item of cases) {
    test(item.name, () => {
      assert.equal(mandatoryGatesGreen(item.doc, item.iteration), item.expected);
    });
  }
});

describe('cycle-state: lock', () => {
  test('второй lock при живом pid — код 3, файл не перезаписывается', (t) => {
    const { root } = makeRepo(t);

    const first = runCli(root, ['lock', '--slug', 'cycle-state', '--now', NOW]);
    assert.equal(first.status, 0, first.stderr);

    const lockFile = join(root, '.pi', 'artifacts', '.lock');
    const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
    assert.deepEqual(lock, { created_at: NOW, pid: lock.pid, slug: 'cycle-state' });
    assert.equal(isAlive(lock.pid), true, 'lock держит живой процесс');
    assert.deepEqual(stdoutJson(first), lock);

    const before = readFileSync(lockFile, 'utf8');
    const second = runCli(root, ['lock', '--now', LATER]);
    assert.equal(second.status, 3);
    assert.equal(readFileSync(lockFile, 'utf8'), before);
  });

  test('мёртвый и битый lock считаются устаревшими и заменяются', (t) => {
    const { root } = makeRepo(t);
    const lockFile = join(root, '.pi', 'artifacts', '.lock');
    mkdirSync(dirname(lockFile), { recursive: true });

    writeFileSync(
      lockFile,
      `${JSON.stringify({ created_at: NOW, pid: deadPid(), slug: null }, null, 2)}\n`,
    );
    const stale = runCli(root, ['lock', '--now', LATER]);
    assert.equal(stale.status, 0, stale.stderr);
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).created_at, LATER);

    writeFileSync(lockFile, 'не json\n');
    const broken = runCli(root, ['lock', '--now', NOW]);
    assert.equal(broken.status, 0, broken.stderr);
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).created_at, NOW);
  });

  test('свежий пустой lock-файл — незавершённый захват: код 3 до unlock', (t) => {
    const { root } = makeRepo(t);
    const lockFile = join(root, '.pi', 'artifacts', '.lock');
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, '');

    const busy = runCli(root, ['lock', '--now', NOW]);
    assert.equal(busy.status, 3, 'пустой файл — захват в процессе, а не устаревший lock');
    assert.equal(readFileSync(lockFile, 'utf8'), '', 'чужой захват не перезаписывается');

    assert.equal(runCli(root, ['unlock']).status, 0);
    const after = runCli(root, ['lock', '--now', NOW]);
    assert.equal(after.status, 0, after.stderr);
  });

  test('заброшенный пустой lock (старше TTL) восстанавливается сам', (t) => {
    const { root } = makeRepo(t);
    const lockFile = join(root, '.pi', 'artifacts', '.lock');
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, '');
    // Сбой между `openSync('wx')` и записью: файл пуст, владельца нет, возраст — за TTL.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lockFile, old, old);

    const result = runCli(root, ['lock', '--slug', 'cycle-state', '--now', NOW]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).pid, JSON.parse(result.stdout).pid);
    assert.equal(existsSync(`${lockFile}.takeover`), false, 'сериализатор убран после захвата');
  });

  test('два lock с исходным мёртвым lock: один код 0, другой 3, снят только один экземпляр', async (t) => {
    const { root } = makeRepo(t);
    const lockFile = join(root, '.pi', 'artifacts', '.lock');
    mkdirSync(dirname(lockFile), { recursive: true });

    // Гонка восстановления: без сериализатора оба процесса снимали бы lock по очереди и оба
    // возвращали 0, а второй сносил бы уже свежую блокировку первого (issue #157, ревью 2).
    for (let round = 0; round < 5; round += 1) {
      writeFileSync(
        lockFile,
        `${JSON.stringify({ created_at: NOW, pid: deadPid(), slug: null }, null, 2)}\n`,
      );

      const results = await Promise.all([spawnLock(root), spawnLock(root)]);
      const codes = results.map((result) => result.status).sort();
      assert.deepEqual(
        codes,
        [0, 3],
        `раунд ${round}: ${results.map((r) => `${r.status} ${r.stderr.trim()}`).join(' | ')}`,
      );

      const winners = results.filter((result) => result.status === 0);
      assert.equal(winners.length, 1, 'ровно один цикл считает блокировку своей');
      const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
      assert.equal(lock.created_at, NOW);
      assert.deepEqual(stdoutJson(winners[0]), lock, 'содержимое lock — документ победителя');
      assert.equal(existsSync(`${lockFile}.takeover`), false, 'сериализатор убран после гонки');

      assert.equal(runCli(root, ['unlock']).status, 0);
    }
  });

  test('восстановление сериализовано: свежий takeover с живым pid не пускает второй lock', (t) => {
    const { root } = makeRepo(t);
    const lockFile = join(root, '.pi', 'artifacts', '.lock');
    mkdirSync(dirname(lockFile), { recursive: true });
    // lock мёртвый (восстанавливать есть что), но сериализатором владеет живой процесс:
    // второй lock обязан отказаться, а не снести lock под руками у первого.
    const deadLock = `${JSON.stringify({ created_at: NOW, pid: deadPid(), slug: null }, null, 2)}\n`;
    writeFileSync(lockFile, deadLock);
    writeFileSync(
      `${lockFile}.takeover`,
      `${JSON.stringify({ created_at: NOW, pid: process.pid, slug: 'cycle-state' }, null, 2)}\n`,
    );

    const result = runCli(root, ['lock', '--now', LATER]);

    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /восстанавливается другим процессом/);
    assert.equal(readFileSync(lockFile, 'utf8'), deadLock, 'чужое восстановление не перебивается');
  });

  test('сериализатор с живым pid, но старше TTL, освобождается', (t) => {
    const { root } = makeRepo(t);
    const lockFile = join(root, '.pi', 'artifacts', '.lock');
    const takeover = `${lockFile}.takeover`;
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(
      lockFile,
      `${JSON.stringify({ created_at: NOW, pid: deadPid(), slug: null }, null, 2)}\n`,
    );
    // Живой pid: аварийно завершённая команда оставила сериализатор, а pid переиспользован.
    writeFileSync(
      takeover,
      `${JSON.stringify({ created_at: NOW, pid: process.pid, slug: 'cycle-state' }, null, 2)}\n`,
    );
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(takeover, old, old);

    const result = runCli(root, ['lock', '--now', LATER]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).created_at, LATER);
    assert.equal(existsSync(takeover), false);
  });

  test('два lock с устаревшими lock и takeover: ровно один код 0, чужого файла не остаётся', async (t) => {
    const { root } = makeRepo(t);
    const lockFile = join(root, '.pi', 'artifacts', '.lock');
    const takeover = `${lockFile}.takeover`;
    mkdirSync(dirname(lockFile), { recursive: true });

    // Оба файла осмотрены как устаревшие одновременно: снятие каждого идёт через переименование
    // с проверкой inode, поэтому чужую (свежую) блокировку потерять нельзя.
    for (let round = 0; round < 5; round += 1) {
      const dead = `${JSON.stringify({ created_at: NOW, pid: deadPid(), slug: null }, null, 2)}\n`;
      writeFileSync(lockFile, dead);
      writeFileSync(takeover, dead);

      const results = await Promise.all([spawnLock(root), spawnLock(root)]);
      const codes = results.map((result) => result.status).sort();
      assert.deepEqual(
        codes,
        [0, 3],
        `раунд ${round}: ${results.map((r) => `${r.status} ${r.stderr.trim()}`).join(' | ')}`,
      );
      const winners = results.filter((result) => result.status === 0);
      assert.deepEqual(stdoutJson(winners[0]), JSON.parse(readFileSync(lockFile, 'utf8')));
      assert.equal(existsSync(takeover), false, 'сериализатор убран');
      assert.equal(
        readdirSync(dirname(lockFile)).some((name) => name.includes('.stale.')),
        false,
        'черновые имена после переименования убраны',
      );

      assert.equal(runCli(root, ['unlock']).status, 0);
    }
  });

  test('claimStaleFile: подменённый файл возвращается на место, а не удаляется', (t) => {
    const { root } = makeRepo(t);
    const file = join(root, '.pi', 'artifacts', 'claimed.lock');
    mkdirSync(dirname(file), { recursive: true });

    // Устаревший файл, который мы осмотрели.
    writeFileSync(file, 'осмотренный\n');
    const inspected = statSync(file).ino;

    // Конкурентный процесс успел заменить файл: другой inode по тому же пути.
    rmSync(file);
    writeFileSync(file, 'чужой свежий\n');

    assert.equal(claimStaleFile(file, inspected), 'other');
    assert.equal(readFileSync(file, 'utf8'), 'чужой свежий\n', 'чужой файл остался на месте');

    // А свой экземпляр снимается: файла после claim нет.
    assert.equal(claimStaleFile(file, statSync(file).ino), 'claimed');
    assert.equal(existsSync(file), false);
    assert.equal(claimStaleFile(file, inspected), 'gone', 'повторный claim — файла нет');
  });

  test('claimStaleFile: возврат чужого файла не затирает появившийся .lock (BLOCKER ревью)', (t) => {
    const { root } = makeRepo(t);
    const file = join(root, '.pi', 'artifacts', '.lock');
    mkdirSync(dirname(file), { recursive: true });

    // Осматривали устаревший файл, но к моменту снятия по пути уже лежит свежий lock.
    writeFileSync(file, 'устаревший\n');
    const alienIno = statSync(file).ino + 1; // inode, которого на пути нет — значит «чужой»

    assert.throws(
      () =>
        claimStaleFile(file, alienIno, {
          // Вклиниваемся в окно между переименованием и возвратом: третий процесс создал свой .lock.
          afterMove: () => writeFileSync(file, 'третий процесс\n'),
        }),
      /перехвачен конкурентным процессом/,
    );

    assert.equal(
      readFileSync(file, 'utf8'),
      'третий процесс\n',
      'файл третьего процесса не перезаписан восстановлением',
    );
  });

  test('claimStaleFile: перемещённому файлу ставится свежий mtime, а исчезновение — исход гонки', (t) => {
    const { root } = makeRepo(t);
    const file = join(root, '.pi', 'artifacts', '.lock');
    mkdirSync(dirname(file), { recursive: true });

    // Старый lock: mtime далеко в прошлом — уборщик остатков не должен принять перенос за мусор.
    writeFileSync(file, 'старый\n');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(file, old, old);
    const inspected = statSync(file).ino;

    assert.equal(
      claimStaleFile(file, inspected, {
        afterMove: (moved) => {
          assert.ok(
            Date.now() - statSync(moved).mtimeMs < 5000,
            'mtime перемещённого файла — момент переноса, а не исходный',
          );
          rmSync(moved); // уборка успела удалить файл: восстанавливать нечего
        },
      }),
      'gone',
      'исчезнувший при переносе файл — исход гонки, а не ошибка',
    );
    assert.equal(existsSync(file), false);
  });

  test('остатки *.stale.*: старый убирается, свежий остаётся', (t) => {
    const { root } = makeRepo(t);
    const lockFile = join(root, '.pi', 'artifacts', '.lock');
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, `${JSON.stringify({ created_at: NOW, pid: deadPid(), slug: null })}\n`);

    const staleName = `${lockFile}.stale.999.1`;
    const freshName = `${lockFile}.stale.999.${Date.now()}`;
    writeFileSync(staleName, 'осиротевший файл\n');
    writeFileSync(freshName, 'идёт перенос\n');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(staleName, old, old);

    const result = runCli(root, ['lock', '--now', LATER]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(staleName), false, 'старый остаток убран');
    assert.equal(existsSync(freshName), true, 'свежий перенос не тронут');
  });

  test('остатки *.stale.* от прерванного восстановления убираются следующим lock', (t) => {
    const { root } = makeRepo(t);
    const lockFile = join(root, '.pi', 'artifacts', '.lock');
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, `${JSON.stringify({ created_at: NOW, pid: deadPid(), slug: null })}\n`);
    const leftover = `${lockFile}.stale.999.1`;
    writeFileSync(leftover, 'осиротевший файл\n');
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(leftover, old, old);

    const result = runCli(root, ['lock', '--now', LATER]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(leftover), false, 'остаток убран');
  });

  test('заброшенный сериализатор (мёртвый pid) не мешает восстановлению', (t) => {
    const { root } = makeRepo(t);
    const lockFile = join(root, '.pi', 'artifacts', '.lock');
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(
      lockFile,
      `${JSON.stringify({ created_at: NOW, pid: deadPid(), slug: null }, null, 2)}\n`,
    );
    writeFileSync(
      `${lockFile}.takeover`,
      `${JSON.stringify({ created_at: NOW, pid: deadPid(), slug: null }, null, 2)}\n`,
    );

    const result = runCli(root, ['lock', '--now', LATER]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(lockFile, 'utf8')).created_at, LATER);
    assert.equal(existsSync(`${lockFile}.takeover`), false);
  });

  test('два одновременных lock: один код 0, другой 3, в .lock один документ', async (t) => {
    const { root } = makeRepo(t);
    const lockFile = join(root, '.pi', 'artifacts', '.lock');

    // Несколько раундов: захват атомарный независимо от взаимного порядка процессов.
    for (let round = 0; round < 5; round += 1) {
      const results = await Promise.all([spawnLock(root), spawnLock(root)]);
      const codes = results.map((result) => result.status).sort();
      assert.deepEqual(
        codes,
        [0, 3],
        `раунд ${round}: ${results.map((r) => `${r.status} ${r.stderr.trim()}`).join(' | ')}`,
      );

      const winners = results.filter((result) => result.status === 0);
      assert.equal(winners.length, 1, 'ровно один захват');

      const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
      assert.deepEqual(lock, { created_at: NOW, pid: lock.pid, slug: 'cycle-state' });
      assert.equal(isAlive(lock.pid), true, 'lock держит живой процесс');
      assert.deepEqual(stdoutJson(winners[0]), lock, 'успешный вывод — единственный документ');

      assert.equal(runCli(root, ['unlock']).status, 0);
      assert.equal(existsSync(lockFile), false);
    }
  });

  test('unlock снимает lock и повторный вызов — no-op', (t) => {
    const { root } = makeRepo(t);
    assert.equal(runCli(root, ['lock', '--now', NOW]).status, 0);

    const lockFile = join(root, '.pi', 'artifacts', '.lock');
    const released = runCli(root, ['unlock']);
    assert.equal(released.status, 0, released.stderr);
    assert.equal(existsSync(lockFile), false);
    assert.deepEqual(stdoutJson(released), {
      command: 'unlock',
      dir: dirname(lockFile),
      released: true,
    });

    const again = runCli(root, ['unlock']);
    assert.equal(again.status, 0);
    assert.equal(stdoutJson(again).released, false);
  });
});

describe('cycle-state: resume', () => {
  test('незакрытая запись — continue, закрытая история — advance', (t) => {
    const { root, baseSha } = makeRepo(t);

    const running = makeCycle(root, {
      state: stateDoc(baseSha, {
        stage: 'GATES',
        stage_status: 'running',
        history: [
          historyEntry('INIT', 'done'),
          historyEntry('GATES', 'running', { finished: false }),
        ],
      }),
      name: '2026-11-16-157-running',
    });
    const continued = runCli(root, ['resume', '--dir', running]);
    assert.equal(continued.status, 0, continued.stderr);
    assert.deepEqual(stdoutJson(continued), {
      action: 'continue',
      allowed_next: [],
      command: 'resume',
      dir: running,
      iteration: 1,
      stage: 'GATES',
      stage_status: 'running',
    });

    const failed = makeCycle(root, {
      state: stateDoc(baseSha, {
        stage: 'REVIEW',
        stage_status: 'error',
        history: [historyEntry('INIT', 'done'), historyEntry('REVIEW', 'error')],
      }),
      name: '2026-11-16-157-failed',
    });
    assert.equal(stdoutJson(runCli(root, ['resume', '--dir', failed])).action, 'continue');
    assert.deepEqual(
      stdoutJson(runCli(root, ['resume', '--dir', failed])).allowed_next,
      ['REVIEW'],
      'после error повторный вход в тот же этап разрешён advance',
    );

    const planned = makeCycle(root, {
      state: stateDoc(baseSha, { stage: 'GATES', stage_status: 'done' }),
      name: '2026-11-16-157-planned',
    });
    const advanced = stdoutJson(runCli(root, ['resume', '--dir', planned]));
    assert.equal(advanced.action, 'advance');
    assert.deepEqual(advanced.allowed_next, ['QA_WEB', 'REVIEW']);
    assert.deepEqual(
      advanced.allowed_next,
      EXPECTED_TRANSITIONS.GATES.filter((stage) => stage !== 'ESCALATED'),
      'цели resume — из таблицы §5.3',
    );
  });

  test('актуальная попытка этапа: error → повторный вход → done → advance', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycle(root, {
      state: stateDoc(baseSha, {
        stage: 'REVIEW',
        stage_status: 'error',
        history: [historyEntry('INIT', 'done'), historyEntry('REVIEW', 'error')],
      }),
    });

    const failed = stdoutJson(runCli(root, ['resume', '--dir', dir]));
    assert.equal(failed.action, 'continue');
    assert.deepEqual(failed.allowed_next, ['REVIEW']);

    const reentry = runCli(root, ['advance', '--dir', dir, '--to', 'REVIEW', '--now', LATER]);
    assert.equal(reentry.status, 0, reentry.stderr);
    const running = stdoutJson(runCli(root, ['resume', '--dir', dir]));
    assert.equal(running.action, 'continue');
    assert.deepEqual(running.allowed_next, [], 'открытая попытка: сначала finish');
    assert.equal(running.stage_status, 'running');

    const finished = runCli(root, [
      'finish',
      '--dir',
      dir,
      '--stage',
      'REVIEW',
      '--status',
      'done',
      '--now',
      LATER,
    ]);
    assert.equal(finished.status, 0, finished.stderr);

    const done = stdoutJson(runCli(root, ['resume', '--dir', dir]));
    assert.equal(done.action, 'advance', 'историческая ошибка не возвращает continue');
    assert.equal(done.stage_status, 'done');
    assert.deepEqual(done.allowed_next, ['EVALUATE', 'DECIDE']);
    assert.equal(
      stateJson(dir).history.some((entry) => entry.status === 'error'),
      true,
      'в истории остаётся старая ошибка — решение принимается по актуальной попытке',
    );
  });

  test('терминальный цикл — код 3', (t) => {
    const { root, baseSha } = makeRepo(t);

    for (const stage of TERMINAL) {
      const dir = makeCycle(root, {
        state: stateDoc(baseSha, { stage }),
        name: `2026-11-16-157-${stage.toLowerCase()}`,
      });
      assert.equal(runCli(root, ['resume', '--dir', dir]).status, 3);
    }
  });
});

describe('cycle-state: детерминизм', () => {
  test('два прогона с одним --now дают побайтно равные state.json и stdout', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycle(root, { state: stateDoc(baseSha, { stage: 'REVIEW' }) });
    writeFileSync(join(dir, 'review.1.md'), '# Ревью\n');
    writeFileSync(join(dir, 'evaluation.1.md'), '# Оценка\n');
    const initial = stateText(dir);

    const first = runCli(root, ['advance', '--dir', dir, '--to', 'DECIDE', '--now', LATER]);
    assert.equal(first.status, 0, first.stderr);
    const firstText = stateText(dir);

    writeFileSync(join(dir, 'state.json'), initial);
    const second = runCli(root, ['advance', '--dir', dir, '--to', 'DECIDE', '--now', LATER]);
    assert.equal(second.status, 0, second.stderr);

    assert.equal(stateText(dir), firstText);
    assert.equal(second.stdout, first.stdout);
  });
});
