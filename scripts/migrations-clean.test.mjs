import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyTestIntLog } from './cycle-gates.mjs';
import {
  gateDatabaseName,
  logTail,
  runCleanMigrations,
  splitDatabaseUrl,
  withDatabase,
} from './migrations-clean.mjs';

/** Путь к CLI: часть проверок идёт отдельным процессом, как гейт. */
const SCRIPT = fileURLToPath(new URL('./migrations-clean.mjs', import.meta.url));

/** Корень репозитория: относительные пути помощников считаются от него. */
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** Строка подключения без пароля — только для проверок формы URL. */
const URL_SAMPLE = 'postgresql://app:hunter2@127.0.0.1:55432/hair_lab?schema=public';

/**
 * Запуск CLI без `DATABASE_URL` в окружении.
 * @param {string|null} url
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runCli(url) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  if (url !== null) env.DATABASE_URL = url;
  return spawnSync(process.execPath, [SCRIPT], { cwd: REPO_ROOT, env, encoding: 'utf8' });
}

describe('migrations-clean: помощники', () => {
  test('splitDatabaseUrl отделяет имя базы от шапки', () => {
    assert.deepEqual(splitDatabaseUrl(URL_SAMPLE), {
      database: 'hair_lab',
      origin: 'postgresql://127.0.0.1:55432',
    });
  });

  test('splitDatabaseUrl отклоняет пустое значение и URL без базы', () => {
    assert.throws(() => splitDatabaseUrl(''), TypeError);
    assert.throws(() => splitDatabaseUrl(null), TypeError);
    assert.throws(() => splitDatabaseUrl('postgresql://app@127.0.0.1:55432/'), /база данных/);
  });

  test('withDatabase меняет только имя базы, сохраняя учётные данные и параметры', () => {
    assert.equal(
      withDatabase(URL_SAMPLE, 'postgres'),
      'postgresql://app:hunter2@127.0.0.1:55432/postgres?schema=public',
    );
  });

  test('имя временной базы уникально и укладывается в 63 байта', () => {
    const name = gateDatabaseName('hair_lab', { pid: 4321, now: 1_700_000_000_000 });
    assert.match(name, /^hair_lab_gate_4321_[0-9a-z]+$/);

    const long = gateDatabaseName('a'.repeat(80), { pid: 4321, now: 1_700_000_000_000 });
    assert.equal(Buffer.byteLength(long, 'utf8'), 63);
    assert.ok(long.endsWith(`_gate_4321_${(1_700_000_000_000).toString(36)}`));
  });

  test('logTail маскирует секреты и оставляет последние строки', () => {
    const text = `${Array.from({ length: 100 }, (_, index) => `строка ${index + 1}`).join('\n')}\npassword=abcdefgh\n`;

    const tail = logTail(text);
    assert.equal(tail.includes('password=[secret]'), true);
    assert.equal(tail.includes('строка 1\n'), false, 'хвост ограничен по строкам');
    assert.equal(tail.includes('строка 100'), true);
    assert.equal(logTail(undefined), '');
  });
});

describe('migrations-clean: жизненный цикл временной базы', () => {
  test('создаёт базу, применяет миграции, проверяет статус и удаляет базу', () => {
    /** @type {{ args: string[], url: string }[]} */
    const calls = [];
    const log = [];
    /** Подменный исполнитель: успешные шаги, без обращения к БД. */
    const execute = (args, { url }) => {
      calls.push({ args, url });
      return { ok: true, exit: 0, output: '' };
    };

    const result = runCleanMigrations({
      url: URL_SAMPLE,
      root: REPO_ROOT,
      log: (line) => log.push(line),
      now: 1_700_000_000_000,
      pid: 4321,
      execute,
    });

    assert.equal(result.ok, true);
    assert.equal(result.database, 'hair_lab_gate_4321_loyw3v28');
    assert.deepEqual(
      calls.map((call) => call.args.join(' ')),
      ['db execute --stdin', 'migrate deploy', 'migrate status', 'db execute --stdin'],
    );
    // Создание и удаление идут через обслуживающую БД, migrate — по временной.
    assert.equal(calls[0].url, withDatabase(URL_SAMPLE, 'postgres'));
    assert.equal(calls[1].url, withDatabase(URL_SAMPLE, result.database));
    assert.equal(calls[3].url, withDatabase(URL_SAMPLE, 'postgres'));
    assert.equal(log.length, 4);
    assert.match(log[0], /временная база hair_lab_gate_4321_/);
    assert.match(log[3], /удалена/);
  });

  test('падение migrate deploy не мешает удалить базу и даёт ok: false', () => {
    /** @type {string[]} */
    const calls = [];
    /** `migrate deploy` падает, уборка должна выполниться всё равно. */
    const execute = (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'migrate' && args[1] === 'deploy') {
        return { ok: false, exit: 1, output: 'Error: P3009: миграция упала' };
      }
      return { ok: true, exit: 0, output: '' };
    };

    const result = runCleanMigrations({
      url: URL_SAMPLE,
      root: REPO_ROOT,
      log: () => {},
      now: 1_700_000_000_000,
      pid: 4321,
      execute,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(calls, ['db execute --stdin', 'migrate deploy', 'db execute --stdin']);
  });

  test('падение CREATE DATABASE не пытается удалять базу', () => {
    /** @type {string[]} */
    const calls = [];
    const execute = (args) => {
      calls.push(args.join(' '));
      return { ok: false, exit: 1, output: "Can't reach database server at `127.0.0.1:1`" };
    };

    const result = runCleanMigrations({
      url: URL_SAMPLE,
      root: REPO_ROOT,
      log: () => {},
      execute,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(calls, ['db execute --stdin']);
  });
});

describe('migrations-clean: CLI', () => {
  test('без DATABASE_URL — код 1 и понятное сообщение, а не «нет БД»', () => {
    const result = runCli(null);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /DATABASE_URL не задан/);
    // Ошибка конфигурации — `fail`, а не `not_run (no_database)` (§5.5).
    assert.equal(classifyTestIntLog(`${result.stdout}${result.stderr}`), 'fail');
  });

  test('недоступная БД — код 1, лог классифицируется как no_database', () => {
    // Порт 1 на loopback закрыт: Prisma отвечает P1001, как при выключенном Postgres.
    const result = runCli('postgresql://app:not-a-secret@127.0.0.1:1/hair_lab?schema=public');

    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /P1001|Can't reach database server/);
    assert.equal(classifyTestIntLog(`${result.stdout}${result.stderr}`), 'no_database');
    assert.equal(result.stdout.includes('not-a-secret'), false, 'пароль не попадает в лог');
  });
});
