import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, test } from 'node:test';

import {
  classifyTestIntLog,
  exitCode,
  gateEnv,
  isGateApplicable,
  parseArgs,
  planRun,
  resolveBaseSha,
  runGates,
  scanAddedLines,
  trimLog,
} from './cycle-gates.mjs';
import { GATES, LIMITS } from './lib/cycle/config.mjs';
import { addedLinesByFile } from './lib/cycle/git.mjs';
import { validateGates } from './lib/cycle/validate.mjs';

// Глобальный и системный конфиг git в тестах не нужен: он мог бы включить подпись коммитов
// или другую базовую ветку. Наследуется `git rev-parse` внутри `resolveBaseSha`.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

/** Корень фикстур: `scripts/fixtures/cycle/`. */
const FIXTURES = new URL('./fixtures/cycle/', import.meta.url);

/** Фиксированное время: детерминизм документа (§5.10) проверяется на нём. */
const FIXED_NOW = Date.parse('2026-11-16T09:10:00Z');

/**
 * Образцы секретов для проверок собираются из частей: цельная секретоподобная строка в
 * тестовом коде стала бы находкой обязательного гейта `secrets_scan` на самом диффе
 * (§5.5), а образцы нужны настоящие — они подаются в `scanSecrets`, а не заменяются
 * заглушкой. Значения вымышленные (§ПДн).
 */
const SAMPLE = Object.freeze({
  aws: ['AKIA', 'Z7Q7EXAMPLE12345'].join(''),
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', 'c2lnbmF0dXJl'].join('.'),
  pemHeader: ['-----BEGIN', 'OPENSSH PRIVATE KEY-----'].join(' '),
  value: ['Zx9', 'train', 'only', '0000'].join('-'),
});

/**
 * Строка присвоения секрета: и ключ, и значение собираются динамически, чтобы в коде теста
 * не было цельного образца.
 * @param {string} key имя переменной (`password`, `API_KEY`, …)
 * @returns {string}
 */
function assignmentLine(key) {
  return `${key} = "${SAMPLE.value}"`;
}

/** Дифф нового файла с секретами: проверяет и разбор `addedLinesByFile`, и `secrets_scan`. */
const LEAK_DIFF = [
  'diff --git a/apps/api/src/leak.ts b/apps/api/src/leak.ts',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/apps/api/src/leak.ts',
  '@@ -0,0 +1,3 @@',
  `+const aws = '${SAMPLE.aws}';`,
  `+const jwt = '${SAMPLE.jwt}';`,
  "+const line = 'обычная строка';",
].join('\n');

/** Гейт таблицы по id: в тестах условий нужны только его префиксы. */
function gateById(id) {
  const gate = GATES.find((candidate) => candidate.id === id);
  assert.ok(gate, `гейт ${id} есть в таблице §5.5`);
  return gate;
}

/**
 * Временный каталог цикла.
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function makeCycleDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hair-lab-gates-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Временный git-репозиторий с одним коммитом в `main` — образец ссылки для `--base`.
 * Идентичность и адрес фиктивные (§ПДн), сеть не используется.
 * @param {import('node:test').TestContext} t
 * @returns {{ dir: string, sha: string }}
 */
function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hair-lab-gates-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  /** @param {string[]} args */
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  git(['-c', 'init.defaultBranch=main', 'init']);
  git(['config', 'user.name', 'Test User']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'tracked.txt'), 'base\n');
  git(['add', 'tracked.txt']);
  git(['commit', '-m', 'base']);

  return { dir, sha: git(['rev-parse', 'HEAD']).trim() };
}

/**
 * Успешный итог гейта с переопределениями.
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function outcome(overrides = {}) {
  return { status: 'pass', exit: 0, duration_s: 1, reason: null, ...overrides };
}

/**
 * Подменный раннер: пишет порядок вызовов и отдаёт заданные итоги.
 * @param {Record<string, Record<string, unknown>>} [outcomes]
 * @returns {{ calls: string[], runner: (definition: any) => Promise<any> }}
 */
function recordingRunner(outcomes = {}) {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    runner: async (definition) => {
      calls.push(definition.id);
      return outcome(outcomes[definition.id] ?? {});
    },
  };
}

/**
 * Разобранная фикстура схемы или лога.
 * @param {string} name имя файла в `scripts/fixtures/cycle/`
 * @returns {any}
 */
function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
}

/**
 * Фикстура-лог гейта как текст.
 * @param {string} name
 * @returns {string}
 */
function fixtureLog(name) {
  return fixture(name).join('\n');
}

/**
 * Проверяет, что процесс жив.
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
 * Ждёт выполнения условия.
 * @param {() => boolean} predicate
 * @param {{ timeoutMs?: number, intervalMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

describe('cycle-gates: план прогона', () => {
  test('план повторяет порядок и состав таблицы §5.5', () => {
    const plan = planRun(GATES, { changed: [] });

    assert.equal(plan.length, GATES.length);
    assert.deepEqual(
      plan.map((item) => item.id),
      GATES.map((gate) => gate.id),
    );
    assert.ok(plan.every((item) => item.decision === 'run' || item.decision === 'skip'));
  });

  test('условные гейты при диффе вне их путей получают skipped и not_applicable', () => {
    const plan = planRun(GATES, { changed: ['docs/orchestrator-core.md'] });
    const skipped = plan.filter((item) => item.decision === 'skip');

    assert.deepEqual(
      skipped.map((item) => item.id),
      ['lint_workflows', 'test_int', 'test_scripts', 'check_harness'],
    );
    assert.ok(skipped.every((item) => item.reason === 'not_applicable'));
    assert.equal(plan.length, GATES.length);
  });

  test('условие запуска: префикс пути или точное совпадение файла', () => {
    const cases = [
      ['.github/workflows/ci.yml', 'lint_workflows'],
      ['apps/api/src/bookings.ts', 'test_int'],
      ['packages/contracts/src/index.ts', 'test_int'],
      ['scripts/lib/cycle/git.mjs', 'test_scripts'],
      ['scripts/cycle-gates.mjs', 'check_harness'],
      ['.pi/agents/code.md', 'check_harness'],
      ['AGENTS.md', 'check_harness'],
    ];

    for (const [changed, id] of cases) {
      const plan = planRun(GATES, { changed: [changed] });
      const item = plan.find((candidate) => candidate.id === id);
      assert.equal(item?.decision, 'run', `${id} должен запускаться при ${changed}`);
    }
  });

  test('условие запуска не срабатывает на похожий, но другой путь', () => {
    assert.equal(isGateApplicable(gateById('check_harness'), ['scripts/lib/cycle/git.mjs']), false);
    assert.equal(isGateApplicable(gateById('check_harness'), ['docs/AGENTS.md']), false);
    assert.equal(isGateApplicable(gateById('test_int'), ['apps/web/src/app.ts']), false);
    assert.equal(
      isGateApplicable(gateById('lint_workflows'), ['.github/ISSUE_TEMPLATE/x.md']),
      false,
    );
  });

  test('--only: выбранные выполняются, остальные наследуют прежний статус', () => {
    const inherited = { contracts_build: { status: 'pass', reason: null } };
    const plan = planRun(GATES, { changed: [], only: ['typecheck'], inherited });

    assert.equal(plan.length, GATES.length);
    assert.deepEqual(
      plan.map((item) => item.decision),
      GATES.map((gate) => (gate.id === 'typecheck' ? 'run' : 'inherit')),
    );
    assert.equal(plan.find((item) => item.id === 'contracts_build')?.reason, null);
  });
});

describe('cycle-gates: выполнение', () => {
  test('гейты выполняются последовательно в порядке таблицы, skipped не запускаются', async (t) => {
    const dir = makeCycleDir(t);
    const { calls, runner } = recordingRunner();

    const run = await runGates({
      changed: [],
      added: [],
      iteration: 1,
      dir,
      now: () => FIXED_NOW,
      runner,
    });

    assert.deepEqual(
      run.gates.map((entry) => entry.id),
      GATES.map((gate) => gate.id),
    );
    assert.deepEqual(calls, [
      'contracts_build',
      'typecheck',
      'lint',
      'check_arch',
      'test',
      'format_check',
    ]);
    assert.equal(run.started_at, new Date(FIXED_NOW).toISOString());

    const skipped = run.gates.find((entry) => entry.id === 'test_int');
    assert.deepEqual(
      { status: skipped?.status, reason: skipped?.reason, exit: skipped?.exit, log: skipped?.log },
      { status: 'skipped', reason: 'not_applicable', exit: null, log: null },
    );

    const executed = run.gates.find((entry) => entry.id === 'lint');
    assert.deepEqual(
      {
        status: executed?.status,
        exit: executed?.exit,
        log: executed?.log,
        cmd: executed?.cmd,
        required: executed?.required,
      },
      {
        status: 'pass',
        exit: 0,
        log: 'gates/lint.1.log',
        cmd: 'pnpm lint',
        required: true,
      },
    );
  });

  test('провал родителя даёт зависимым not_run с blocked_by:<id>', async (t) => {
    const dir = makeCycleDir(t);
    const { calls, runner } = recordingRunner({ contracts_build: { status: 'fail', exit: 2 } });

    const run = await runGates({
      changed: ['apps/api/src/bookings.ts'],
      iteration: 1,
      dir,
      now: () => FIXED_NOW,
      runner,
    });

    const blocked = run.gates.filter((entry) => entry.reason?.startsWith('blocked_by:'));
    assert.deepEqual(
      blocked.map((entry) => entry.id),
      ['typecheck', 'test', 'test_int'],
    );
    assert.ok(blocked.every((entry) => entry.status === 'not_run'));
    assert.ok(blocked.every((entry) => entry.reason === 'blocked_by:contracts_build'));
    assert.ok(!calls.includes('typecheck'), 'заблокированный гейт не запускается');
    assert.ok(calls.includes('lint'), 'гейты без зависимости выполняются независимо');
  });

  test('not_run родителя тоже блокирует зависимые', async (t) => {
    const dir = makeCycleDir(t);
    const { runner } = recordingRunner({ contracts_build: { status: 'not_run', exit: null } });

    const run = await runGates({
      changed: ['packages/contracts/src/index.ts'],
      iteration: 1,
      dir,
      now: () => FIXED_NOW,
      runner,
    });

    for (const id of ['typecheck', 'test', 'test_int']) {
      const entry = run.gates.find((candidate) => candidate.id === id);
      assert.deepEqual(
        { status: entry?.status, reason: entry?.reason },
        { status: 'not_run', reason: 'blocked_by:contracts_build' },
        `${id} должен быть заблокирован`,
      );
    }
  });

  test('--only наследует статусы, а наследованный fail блокирует зависимые', async (t) => {
    const dir = makeCycleDir(t);
    const inherited = {
      contracts_build: {
        id: 'contracts_build',
        cmd: 'pnpm --filter @hair-lab/contracts build',
        required: true,
        status: 'fail',
        exit: 1,
        duration_s: 3.5,
        log: 'gates/contracts_build.1.log',
        reason: null,
      },
      lint: {
        id: 'lint',
        cmd: 'pnpm lint',
        required: true,
        status: 'pass',
        exit: 0,
        duration_s: 4,
        log: 'gates/lint.1.log',
        reason: null,
      },
    };
    const { calls, runner } = recordingRunner();

    const run = await runGates({
      changed: [],
      iteration: 1,
      dir,
      only: ['typecheck'],
      inherited,
      now: () => FIXED_NOW,
      runner,
    });

    assert.deepEqual(calls, [], 'при --only выполняется только выбранный гейт');
    const typecheck = run.gates.find((entry) => entry.id === 'typecheck');
    assert.deepEqual(
      { status: typecheck?.status, reason: typecheck?.reason },
      { status: 'not_run', reason: 'blocked_by:contracts_build' },
    );

    const contracts = run.gates.find((entry) => entry.id === 'contracts_build');
    assert.deepEqual(
      { status: contracts?.status, exit: contracts?.exit, log: contracts?.log },
      { status: 'fail', exit: 1, log: 'gates/contracts_build.1.log' },
    );

    const lint = run.gates.find((entry) => entry.id === 'lint');
    assert.equal(lint?.status, 'pass');

    const orphan = run.gates.find((entry) => entry.id === 'check_arch');
    assert.deepEqual(
      {
        status: orphan?.status,
        reason: orphan?.reason,
        exit: orphan?.exit,
        duration: orphan?.duration_s,
      },
      { status: 'not_run', reason: null, exit: null, duration: 0 },
    );
  });

  test('прогон детерминирован при фиксированном now', async (t) => {
    const dir = makeCycleDir(t);
    const first = await runGates({
      changed: ['apps/api/src/bookings.ts'],
      added: addedLinesByFile(LEAK_DIFF),
      iteration: 1,
      dir,
      now: () => FIXED_NOW,
      runner: recordingRunner().runner,
    });
    const second = await runGates({
      changed: ['apps/api/src/bookings.ts'],
      added: addedLinesByFile(LEAK_DIFF),
      iteration: 1,
      dir,
      now: () => FIXED_NOW,
      runner: recordingRunner().runner,
    });

    assert.deepEqual(first, second);
  });

  test('runGates не пишет gates.<n>.json: артефакт создаёт только CLI после проверки', async (t) => {
    const dir = makeCycleDir(t);

    await runGates({ iteration: 1, dir, now: () => FIXED_NOW, runner: recordingRunner().runner });

    assert.equal(existsSync(join(dir, 'gates.1.json')), false);
  });

  test('документ прогона проходит валидатор gates (§5.5, Приложение A)', async (t) => {
    const dir = makeCycleDir(t);
    const run = await runGates({
      changed: ['apps/api/src/bookings.ts'],
      added: addedLinesByFile(LEAK_DIFF),
      iteration: 1,
      dir,
      now: () => FIXED_NOW,
      runner: recordingRunner({ lint: { status: 'fail', exit: 1 } }).runner,
    });

    const doc = {
      iteration: 1,
      base_sha: '0123456789abcdef0123456789abcdef01234567',
      head: '89abcdef0123456789abcdef0123456789abcdef',
      ...run,
    };

    assert.deepEqual(validateGates(doc), { ok: true, errors: [] });
    assert.equal(exitCode(doc), 1);
  });
});

describe('cycle-gates: test_int по логу', () => {
  const classifyCases = [
    ['test-int.connection-refused.json', 'no_database'],
    ['test-int.prisma-p1001.json', 'no_database'],
    ['test-int.auth-failed.json', 'fail'],
  ];

  for (const [name, expected] of classifyCases) {
    test(`лог ${name} классифицируется как ${expected}`, () => {
      assert.equal(classifyTestIntLog(fixtureLog(name)), expected);
    });
  }

  const tokenCases = [
    ['connect ECONNREFUSED 127.0.0.1:55432', 'no_database'],
    ['getaddrinfo ENOTFOUND db.internal', 'no_database'],
    ["Can't reach database server at `127.0.0.1:55432`", 'no_database'],
    ['error code: P1001', 'no_database'],
    ['error: password authentication failed for user "app"', 'fail'],
    ['PrismaClientKnownRequestError: Unique constraint failed', 'fail'],
    ['', 'fail'],
  ];

  for (const [text, expected] of tokenCases) {
    test(`строка лога ${JSON.stringify(text)} классифицируется как ${expected}`, () => {
      assert.equal(classifyTestIntLog(text), expected);
    });
  }

  test('классификатор отклоняет нестроковый вход', () => {
    assert.throws(() => classifyTestIntLog(null), TypeError);
  });

  test('runGates превращает отказ соединения в not_run с причиной no_database', async (t) => {
    const dir = makeCycleDir(t);
    mkdirSync(join(dir, 'gates'), { recursive: true });
    writeFileSync(
      join(dir, 'gates', 'test_int.1.log'),
      fixtureLog('test-int.connection-refused.json'),
    );

    const run = await runGates({
      changed: ['apps/api/src/bookings.ts'],
      iteration: 1,
      dir,
      now: () => FIXED_NOW,
      runner: recordingRunner({ test_int: { status: 'fail', exit: 1 } }).runner,
    });

    const entry = run.gates.find((candidate) => candidate.id === 'test_int');
    assert.deepEqual(
      { status: entry?.status, reason: entry?.reason, log: entry?.log },
      { status: 'not_run', reason: 'no_database', log: 'gates/test_int.1.log' },
    );
  });

  test('runGates оставляет fail при отказе аутентификации', async (t) => {
    const dir = makeCycleDir(t);
    mkdirSync(join(dir, 'gates'), { recursive: true });
    writeFileSync(join(dir, 'gates', 'test_int.1.log'), fixtureLog('test-int.auth-failed.json'));

    const run = await runGates({
      changed: ['apps/api/src/bookings.ts'],
      iteration: 1,
      dir,
      now: () => FIXED_NOW,
      runner: recordingRunner({ test_int: { status: 'fail', exit: 1 } }).runner,
    });

    const entry = run.gates.find((candidate) => candidate.id === 'test_int');
    assert.deepEqual(
      { status: entry?.status, reason: entry?.reason },
      { status: 'fail', reason: null },
    );
  });
});

describe('cycle-gates: secrets_scan', () => {
  test('чистый дифф даёт pass без лога', async (t) => {
    const dir = makeCycleDir(t);

    const run = await runGates({
      added: [{ file: 'apps/api/src/app.ts', lines: [{ line: 1, text: 'export const x = 1;' }] }],
      iteration: 1,
      dir,
      now: () => FIXED_NOW,
      runner: recordingRunner().runner,
    });

    const entry = run.gates.find((candidate) => candidate.id === 'secrets_scan');
    assert.deepEqual(
      { status: entry?.status, log: entry?.log, cmd: entry?.cmd },
      { status: 'pass', log: null, cmd: null },
    );
    assert.equal(existsSync(join(dir, 'gates', 'secrets_scan.1.log')), false);
  });

  test('находки дают fail, лог содержит file:line и вид, но не значение секрета', async (t) => {
    const dir = makeCycleDir(t);

    const run = await runGates({
      added: addedLinesByFile(LEAK_DIFF),
      iteration: 1,
      dir,
      now: () => FIXED_NOW,
      runner: recordingRunner().runner,
    });

    const entry = run.gates.find((candidate) => candidate.id === 'secrets_scan');
    assert.deepEqual(
      { status: entry?.status, log: entry?.log },
      { status: 'fail', log: 'gates/secrets_scan.1.log' },
    );

    const log = readFileSync(join(dir, 'gates', 'secrets_scan.1.log'), 'utf8');
    assert.match(log, /^apps\/api\/src\/leak\.ts:1 aws_access_key$/m);
    assert.match(log, /^apps\/api\/src\/leak\.ts:2 jwt$/m);
    assert.equal(log.includes(SAMPLE.aws), false, 'значение AWS-ключа в лог не попадает');
    assert.equal(log.includes(SAMPLE.jwt), false, 'значение JWT в лог не попадает');
  });

  test('.env.example — единственное исключение, остальные .env* проверяются', () => {
    const envLine = assignmentLine('PASSWORD');
    const cases = [
      ['.env.example', 0],
      ['.ENV.EXAMPLE', 0],
      ['apps/api/.env.example', 0],
      ['.env', 1],
      ['.env.local', 1],
      ['apps/api/.env.production', 1],
    ];

    for (const [file, expected] of cases) {
      const findings = scanAddedLines([{ file, lines: [{ line: 7, text: envLine }] }]);
      assert.equal(findings.length > 0 ? 1 : 0, expected, `файл ${file}`);
    }
  });

  test('scanAddedLines берёт настоящие номера строк файла и не меняет порядок', () => {
    const findings = scanAddedLines([
      {
        file: 'scripts/seed.mjs',
        lines: [
          { line: 12, text: SAMPLE.pemHeader },
          { line: 13, text: 'const s = "обычная строка";' },
          { line: 14, text: assignmentLine('password') },
        ],
      },
      { file: '.env.example', lines: [{ line: 1, text: assignmentLine('API_KEY') }] },
    ]);

    assert.deepEqual(findings, [
      { file: 'scripts/seed.mjs', line: 12, kind: 'private_key' },
      { file: 'scripts/seed.mjs', line: 14, kind: 'assigned_secret' },
    ]);
  });

  test('scanAddedLines отклоняет нестроковый вход', () => {
    assert.throws(() => scanAddedLines('не массив'), TypeError);
  });
});

describe('cycle-gates: лог и тайм-аут', () => {
  test('gateEnv включает TURBO_FORCE и сохраняет остальное окружение', () => {
    const env = gateEnv({ PATH: '/usr/bin', DATABASE_URL: 'postgresql://localhost/x' });

    assert.equal(env.TURBO_FORCE, 'true', 'turbo обязан исполнить задачу, а не отдать кэш');
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.DATABASE_URL, 'postgresql://localhost/x', 'окружение не теряется');
  });

  test('гейт запускается с TURBO_FORCE=true: pass — живой прогон, а не FULL TURBO', async (t) => {
    const dir = makeCycleDir(t);
    const definitions = [
      {
        id: 'probe_env',
        cmd: `${process.execPath} -p process.env.TURBO_FORCE`,
        required: true,
        dependsOn: [],
        pathPrefixes: [],
      },
    ];

    const run = await runGates({ definitions, iteration: 1, dir, runner: undefined });
    const entry = run.gates[0];

    assert.equal(entry.status, 'pass', entry.reason ?? '');
    assert.equal(readFileSync(join(dir, entry.log), 'utf8').trim(), 'true');
  });

  test('лог больше logMaxBytes обрезается до хвоста по границе строки', (t) => {
    const dir = makeCycleDir(t);
    const file = join(dir, 'big.log');
    const line = 'x'.repeat(8191);
    const lines = Array.from({ length: 800 }, (_, index) => `${line}${index}`);
    writeFileSync(file, `${lines.join('\n')}\n`);
    assert.ok(statSync(file).size > LIMITS.logMaxBytes);

    assert.equal(trimLog(file), true);

    const text = readFileSync(file, 'utf8');
    assert.ok(statSync(file).size <= LIMITS.logMaxBytes);
    assert.ok(text.endsWith(`${lines.at(-1)}\n`), 'последняя строка сохранена');
    assert.ok(!text.startsWith(lines[0]), 'начало файла отрезано');
    for (const kept of text.replace(/\n$/, '').split('\n')) {
      assert.match(kept, /^x{8191}\d{1,3}$/, 'строка не обрезана посередине');
    }
  });

  test('небольшой лог не трогается', (t) => {
    const dir = makeCycleDir(t);
    const file = join(dir, 'small.log');
    writeFileSync(file, 'строка\n');

    assert.equal(trimLog(file), false);
    assert.equal(readFileSync(file, 'utf8'), 'строка\n');
  });

  test('тайм-аут завершает процесс и его потомков: fail с причиной timeout', async (t) => {
    const dir = makeCycleDir(t);
    const pidFile = join(dir, 'grandchild.pid');
    const script = join(dir, 'spawner.mjs');
    writeFileSync(
      script,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {",
        "  stdio: 'ignore',",
        '});',
        `writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );

    /** @type {number|null} */
    let grandchildPid = null;
    t.after(() => {
      if (grandchildPid !== null && isAlive(grandchildPid)) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // Процесса уже нет — это и есть ожидаемый результат теста.
        }
      }
    });

    const definitions = [
      {
        id: 'slow_gate',
        cmd: `${process.execPath} ${script}`,
        required: true,
        dependsOn: [],
        pathPrefixes: [],
      },
    ];

    const run = await runGates({
      definitions,
      iteration: 1,
      dir,
      timeouts: { slow_gate: 1500 },
      graceMs: 100,
      runner: undefined,
    });

    const entry = run.gates[0];
    assert.deepEqual(
      { status: entry.status, reason: entry.reason, exit: entry.exit },
      { status: 'fail', reason: 'timeout', exit: null },
    );
    assert.equal(entry.log, 'gates/slow_gate.1.log');

    assert.ok(await waitFor(() => existsSync(pidFile)), 'потомок должен успеть записать pid');
    grandchildPid = Number(readFileSync(pidFile, 'utf8'));

    const dead = await waitFor(() => !isAlive(grandchildPid));
    assert.equal(dead, true, `потомок ${grandchildPid} должен быть завершён вместе с группой`);
  });

  test('тайм-аут убивает потомка, игнорирующего SIGTERM: группа получает SIGKILL', async (t) => {
    const dir = makeCycleDir(t);
    const pidFile = join(dir, 'stubborn.pid');
    const script = join(dir, 'stubborn.mjs');
    // Потомок игнорирует SIGTERM и не держит открытыми stdout/stderr: он пережил бы
    // закрытие лидера, если бы SIGKILL группе отменялся вместе с ним.
    const ignoreTerm = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
    writeFileSync(
      script,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(ignoreTerm)}], {`,
        "  stdio: 'ignore',",
        '});',
        `writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );

    /** @type {number|null} */
    let grandchildPid = null;
    t.after(() => {
      if (grandchildPid !== null && isAlive(grandchildPid)) {
        try {
          process.kill(grandchildPid, 'SIGKILL');
        } catch {
          // Процесса уже нет — это и есть ожидаемый результат теста.
        }
      }
    });

    const definitions = [
      {
        id: 'slow_gate',
        cmd: `${process.execPath} ${script}`,
        required: true,
        dependsOn: [],
        pathPrefixes: [],
      },
    ];

    const run = await runGates({
      definitions,
      iteration: 1,
      dir,
      timeouts: { slow_gate: 1500 },
      graceMs: 100,
      runner: undefined,
    });

    const entry = run.gates[0];
    assert.deepEqual(
      { status: entry.status, reason: entry.reason, exit: entry.exit },
      { status: 'fail', reason: 'timeout', exit: null },
    );

    assert.ok(await waitFor(() => existsSync(pidFile)), 'потомок должен успеть записать pid');
    grandchildPid = Number(readFileSync(pidFile, 'utf8'));

    const dead = await waitFor(() => !isAlive(grandchildPid));
    assert.equal(
      dead,
      true,
      `потомок ${grandchildPid}, игнорирующий SIGTERM, должен получить SIGKILL группы`,
    );
  });
});

describe('cycle-gates: CLI', () => {
  test('parseArgs разбирает путь, --only и --base', () => {
    assert.deepEqual(parseArgs(['--dir', '/tmp/cycle', '--only', 'secrets_scan,typecheck']), {
      dir: '/tmp/cycle',
      only: ['typecheck', 'secrets_scan'],
      base: null,
    });
    assert.deepEqual(parseArgs([]), { dir: null, only: null, base: null });
    assert.deepEqual(parseArgs(['--base', 'a'.repeat(40)]), {
      dir: null,
      only: null,
      base: 'a'.repeat(40),
    });
    // Имя ссылки разбор принимает как есть: резолв в sha — дело `resolveBaseSha`.
    assert.equal(parseArgs(['--base', 'main']).base, 'main');
  });

  test('resolveBaseSha резолвит имя ссылки в полный sha, который принимает валидатор', async (t) => {
    const { dir: repo, sha } = makeRepo(t);
    const dir = makeCycleDir(t);

    const base = resolveBaseSha({ base: 'main', cwd: repo });
    assert.match(base, /^[0-9a-f]{40}$/);
    assert.equal(base, sha);
    assert.equal(resolveBaseSha({ base: 'HEAD', cwd: repo }), sha);
    assert.equal(resolveBaseSha({ base: sha, cwd: repo }), sha);

    const run = await runGates({
      iteration: 1,
      dir,
      now: () => FIXED_NOW,
      runner: recordingRunner().runner,
    });
    assert.deepEqual(validateGates({ iteration: 1, base_sha: base, head: sha, ...run }), {
      ok: true,
      errors: [],
    });
  });

  test('resolveBaseSha отклоняет недопустимую и несуществующую ссылку', (t) => {
    const { dir } = makeRepo(t);

    for (const base of ['no-such-branch', '--output=/tmp/x', 'main..x', 'main main', '', '   ']) {
      assert.throws(
        () => resolveBaseSha({ base, cwd: dir }),
        /base:/,
        `ссылка должна отклоняться: ${base}`,
      );
    }
    assert.equal(existsSync('/tmp/x'), false, 'файл из --output=/tmp/x не должен создаваться');
  });

  test('мусор в аргументах — ошибка использования (код 2)', () => {
    const bad = [
      ['--only'],
      ['--only', '--dir', '/tmp'],
      ['--only', 'typecheck,'],
      ['--only', 'unknown_gate'],
      ['--dir'],
      ['--dir', '--only'],
      ['--base'],
      ['--unknown'],
      ['positional'],
    ];

    for (const argv of bad) {
      assert.throws(
        () => parseArgs(argv),
        Error,
        `аргументы должны отклоняться: ${argv.join(' ')}`,
      );
    }
  });

  test('код выхода: 0 без обязательных fail, 1 при обязательном fail', () => {
    const gates = [
      { id: 'lint', required: true, status: 'pass' },
      { id: 'test', required: true, status: 'not_run' },
      { id: 'lint_workflows', required: true, status: 'skipped' },
      { id: 'secrets_scan', required: true, status: 'pass' },
    ];
    assert.equal(exitCode({ gates }), 0);
    assert.equal(exitCode({ gates: [{ id: 'lint', required: true, status: 'fail' }] }), 1);
    assert.equal(exitCode({ gates: [{ id: 'lint', required: false, status: 'fail' }] }), 0);
  });
});
