import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runTestInt } from './test-int.mjs';

/** Путь к CLI: часть проверок идёт отдельным процессом, как настоящий `pnpm test:int`. */
const SCRIPT = fileURLToPath(new URL('./test-int.mjs', import.meta.url));

/** Корень репозитория: относительные пути помощников считаются от него. */
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const BASE_URL = 'postgresql://hair_lab:change_me@127.0.0.1:55432/hair_lab?schema=public';

/**
 * Поддельный исполнитель Prisma: записывает вызовы и отвечает по сценарию.
 * @param {{ failOn?: 'create'|'deploy'|'drop' }} [options]
 */
function createExecutor(options = {}) {
  /** @type {Array<{ args: string[], url: string, input: string }>} */
  const calls = [];
  const execute = (args, { url, input = '' }) => {
    calls.push({ args, url, input });
    const step = args[0] === 'db' ? (input.startsWith('CREATE') ? 'create' : 'drop') : 'deploy';
    const ok = step === options.failOn ? false : true;
    return { ok, exit: ok ? 0 : 1, output: ok ? '' : `сбой ${step}` };
  };
  return { calls, execute };
}

describe('test:int: временная база прогона', () => {
  test('создаёт базу, накатывает миграции, гоняет тесты и удаляет базу', () => {
    const { calls, execute } = createExecutor();
    /** @type {Array<{ url: string, env: NodeJS.ProcessEnv }>} */
    const runs = [];
    const result = runTestInt({
      url: BASE_URL,
      root: REPO_ROOT,
      log: () => {},
      now: 1_700_000_000_000,
      pid: 4242,
      execute,
      runTests: ({ url, env }) => {
        runs.push({ url, env });
        return 0;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.exit, 0);
    assert.equal(result.database, 'hair_lab_test_4242_loyw3v28');

    // Порядок: CREATE → migrate deploy → DROP, и CREATE/DROP идут в обслуживающую базу.
    assert.deepEqual(
      calls.map((call) =>
        call.input.startsWith('CREATE') ? 'create' : call.args[0] === 'db' ? 'drop' : 'deploy',
      ),
      ['create', 'deploy', 'drop'],
    );
    assert.match(calls[0]?.url ?? '', /\/postgres\?/);
    assert.match(calls[1]?.url ?? '', /\/hair_lab_test_4242_/);
    assert.match(calls[2]?.url ?? '', /\/postgres\?/);

    // Тесты видят ТОЛЬКО временную базу и не наследуют dev-базу.
    assert.equal(runs.length, 1);
    assert.match(runs[0]?.url ?? '', /\/hair_lab_test_4242_/);
    assert.equal(runs[0]?.env.DATABASE_URL, runs[0]?.url);
  });

  test('падение migrate deploy не запускает тесты, база удаляется, код ненулевой', () => {
    const { calls, execute } = createExecutor({ failOn: 'deploy' });
    let ran = false;
    const result = runTestInt({
      url: BASE_URL,
      root: REPO_ROOT,
      log: () => {},
      pid: 7,
      now: 1,
      execute,
      runTests: () => {
        ran = true;
        return 0;
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.exit, 1);
    assert.equal(ran, false);
    assert.equal(calls.at(-1)?.input.startsWith('DROP'), true);
  });

  test('упавшие тесты дают ok: false и код прогона, база удаляется', () => {
    const { calls, execute } = createExecutor();
    const result = runTestInt({
      url: BASE_URL,
      root: REPO_ROOT,
      log: () => {},
      pid: 8,
      now: 2,
      execute,
      runTests: () => 1,
    });

    assert.equal(result.ok, false);
    assert.equal(result.exit, 1);
    assert.equal(calls.at(-1)?.input.startsWith('DROP'), true);
  });

  test('падение CREATE DATABASE не запускает тесты и ничего не удаляет', () => {
    const { calls, execute } = createExecutor({ failOn: 'create' });
    const result = runTestInt({
      url: BASE_URL,
      root: REPO_ROOT,
      log: () => {},
      pid: 9,
      now: 3,
      execute,
      runTests: () => 0,
    });

    assert.equal(result.ok, false);
    assert.equal(result.exit, 1);
    assert.equal(calls.length, 1);
  });

  test('ошибка DROP не меняет вердикт, но попадает в лог', () => {
    const { execute } = createExecutor({ failOn: 'drop' });
    /** @type {string[]} */
    const lines = [];
    const result = runTestInt({
      url: BASE_URL,
      root: REPO_ROOT,
      log: (line) => lines.push(line),
      pid: 10,
      now: 4,
      execute,
      runTests: () => 0,
    });

    assert.equal(result.ok, true);
    assert.equal(
      lines.some((line) => line.includes('DROP DATABASE — код 1')),
      true,
    );
  });

  test('имя временной базы не длиннее 63 байт и не содержит dev-имя без хвоста', () => {
    const long = `postgresql://u:p@127.0.0.1:55432/${'очень_длинное_имя_базы'.repeat(3)}?schema=public`;
    const { execute } = createExecutor();
    const result = runTestInt({
      url: long,
      root: REPO_ROOT,
      log: () => {},
      pid: 11,
      now: 5,
      execute,
      runTests: () => 0,
    });

    assert.equal(Buffer.byteLength(result.database, 'utf8') <= 63, true);
    assert.match(result.database, /_test_11_/);
  });
});

describe('test:int: CLI', () => {
  test('без DATABASE_URL — код 1 и понятное сообщение, а не «нет БД»', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.HL_TEST_INT_CHILD;
    const result = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /DATABASE_URL не задан/u);
  });

  test('вложенный вызов не создаёт базу рекурсивно', () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, DATABASE_URL: BASE_URL, HL_TEST_INT_CHILD: '1' },
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /вложенный вызов/u);
  });
});
