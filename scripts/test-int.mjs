#!/usr/bin/env node
/**
 * `pnpm test:int` на **временной** базе прогона (issue #89).
 *
 * Почему не на dev-БД: интеграционные тесты диспетчера вызывают настоящий тик, а `claim`
 * выбирает `pending`-строки всей таблицы и лимиты считает глобально. На общей dev-БД в прогон
 * попадали письма от ручных проверок — они уходили в поддельный транспорт и помечались
 * `sent`/`failed`, хотя никуда не отправлялись; на «нагруженной» базе тик мог вернуть
 * `rateLimited` и уронить тест по причине, не связанной с проверяемым поведением. Тот же
 * класс проблем ловили тесты, ожидающие ровно свои строки за день (issue #253).
 *
 * Что делает скрипт: `<database>_test_<pid>_<время>` → `prisma migrate deploy` → `turbo run
 * test:int` с подменённым `DATABASE_URL` → `DROP DATABASE` в `finally`. Так локальный прогон
 * идёт в тех же условиях, что в CI (там Postgres поднимается пустым), и dev-данные не
 * затрагиваются ни на чтение, ни на запись.
 *
 * `DATABASE_URL` берётся из окружения (`.env` не читается): это база-**шаблон**, из неё
 * наследуются сервер, учётные данные и параметры `?schema=…`. Роль нужна с правом `CREATEDB`.
 * Нет переменной — код 1: это ошибка конфигурации, а не отсутствие базы (классификатор гейтов
 * отличает их по логу, как у `migrations-clean.mjs`).
 *
 * Вывод: шаги и коды выхода; строка подключения и пароль в лог не попадают.
 *
 * Shebang нужен: файл запускается напрямую.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPrismaExecutor,
  logTail,
  MAINTENANCE_DATABASE,
  splitDatabaseUrl,
  temporaryDatabaseName,
  withDatabase,
} from './lib/db-url.mjs';

/** Prisma CLI пакета `api`: там он и установлен, и оттуда виден `prisma.config.ts`. */
const API_DIR = join('apps', 'api');
const PRISMA_BIN = join(API_DIR, 'node_modules', '.bin', 'prisma');

/** Турбо-раннер интеграционных тестов: задача `test:int` в пакетах воркспейса. */
const TURBO_BIN = join('node_modules', '.bin', 'turbo');

/**
 * Признак вложенного вызова: если турбо когда-нибудь начнёт исполнять корневой `test:int`,
 * скрипт не должен создавать базу рекурсивно. Сейчас турбо задачи корневого пакета не запускает.
 */
const CHILD_MARKER = 'HL_TEST_INT_CHILD';

/**
 * Прогон интеграционных тестов на временной базе.
 * @param {{
 *   url: string,
 *   root: string,
 *   log: (line: string) => void,
 *   now?: number,
 *   pid?: number,
 *   execute?: (args: string[], options: { url: string, input?: string }) => { ok: boolean, exit: number|null, output: string },
 *   runTests?: (options: { url: string, root: string, env: NodeJS.ProcessEnv }) => number|null,
 * }} options
 * @returns {{ ok: boolean, exit: number|null, database: string }}
 */
export function runTestInt({
  url,
  root,
  log,
  now = Date.now(),
  pid = process.pid,
  execute = createPrismaExecutor(root),
  runTests = runTestsInChild,
}) {
  const { database } = splitDatabaseUrl(url);
  const testDatabase = temporaryDatabaseName(database, { marker: 'test', pid, now });
  const testUrl = withDatabase(url, testDatabase);
  const adminUrl = withDatabase(url, MAINTENANCE_DATABASE);

  log(`test:int: временная база ${testDatabase}`);

  const create = execute(['db', 'execute', '--stdin'], {
    url: adminUrl,
    input: `CREATE DATABASE "${testDatabase}"`,
  });
  if (!create.ok) {
    log(`test:int: CREATE DATABASE — код ${create.exit}`);
    log(logTail(create.output));
    return { ok: false, exit: create.exit, database: testDatabase };
  }

  try {
    const deploy = execute(['migrate', 'deploy'], { url: testUrl });
    log(`test:int: prisma migrate deploy — код ${deploy.exit}`);
    if (!deploy.ok) {
      log(logTail(deploy.output));
      return { ok: false, exit: deploy.exit, database: testDatabase };
    }

    // Прогон в дочернем процессе: тесты видят временную базу в `DATABASE_URL`, а не dev-базу.
    const exit = runTests({
      url: testUrl,
      root,
      env: { ...process.env, DATABASE_URL: testUrl, [CHILD_MARKER]: '1' },
    });
    log(`test:int: прогон тестов — код ${exit}`);
    return { ok: exit === 0, exit, database: testDatabase };
  } finally {
    // Удаление — в любом исходе; ошибка уборки не меняет вердикт, но видна в логе.
    const drop = execute(['db', 'execute', '--stdin'], {
      url: adminUrl,
      input: `DROP DATABASE IF EXISTS "${testDatabase}"`,
    });
    log(
      drop.ok
        ? `test:int: временная база ${testDatabase} удалена`
        : `test:int: DROP DATABASE — код ${drop.exit} (база ${testDatabase} осталась)`,
    );
  }
}

/**
 * Запуск `turbo run test:int` без оболочки: аргументы не склеиваются в строку, окружение
 * (вместе с подменённым `DATABASE_URL`) передаётся целиком, вывод идёт в консоль как есть.
 * @param {{ root: string, env: NodeJS.ProcessEnv }} options
 * @returns {number|null}
 */
function runTestsInChild({ root, env }) {
  const result = spawnSync(join(root, TURBO_BIN), ['run', 'test:int'], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  return result.status;
}

/**
 * Точка входа CLI: `DATABASE_URL` из окружения, код возврата — код прогона тестов.
 * @returns {void}
 */
function main() {
  const url = process.env.DATABASE_URL;
  if (typeof url !== 'string' || url.trim() === '') {
    process.stderr.write(
      'test:int: DATABASE_URL не задан в окружении — временную базу не из чего создать\n',
    );
    process.exitCode = 1;
    return;
  }

  if (process.env[CHILD_MARKER] === '1') {
    process.stderr.write(
      'test:int: вложенный вызов (HL_TEST_INT_CHILD=1) — скрипт не создаёт базу рекурсивно\n',
    );
    process.exitCode = 1;
    return;
  }

  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const bin of [PRISMA_BIN, TURBO_BIN]) {
    if (!existsSync(join(root, bin))) {
      process.stderr.write(`test:int: не найден ${bin} — выполните pnpm install\n`);
      process.exitCode = 1;
      return;
    }
  }

  const result = runTestInt({
    url,
    root,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  process.exitCode = result.ok ? 0 : (result.exit ?? 1);
}

// Модуль импортируется тестами ради `runTestInt`; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
