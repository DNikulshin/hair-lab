#!/usr/bin/env node
/**
 * Гейт `migrations_clean` (#250): применяет миграции Prisma на **пустой** временной БД,
 * чтобы «миграция проверена на чистой БД» была проверяема в цикле, а не только в CI.
 *
 * Почему отдельная база: `test_int` гоняется против dev-БД, где миграции уже применены,
 * поэтому `prisma migrate deploy` там ничего не доказывает. Временная БД
 * `<database>_gate_<pid>_<время>` создаётся перед прогоном и удаляется после (в `finally`),
 * данные проекта не затрагиваются: `CREATE`/`DROP` выполняются только для этого имени.
 *
 * Класс отказа (docs/orchestrator-core.md §5.5): ошибки соединения (Prisma `P1001`,
 * `ECONNREFUSED`, `ENOTFOUND`, «Can't reach database server») классификатор гейтов
 * превращает в `not_run (no_database)`. Отсутствие `DATABASE_URL` — `fail`: это ошибка
 * конфигурации окружения, а не отсутствие БД (как у `test_int`).
 *
 * Вывод: только шаги, коды выхода и (при падении) хвост вывода после маскирования —
 * строка подключения и пароль в лог не попадают.
 *
 * Shebang нужен: файл запускается напрямую (гейт `node scripts/migrations-clean.mjs`).
 */
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

// Помощники живут в `lib/db-url.mjs`: те же правила разбирают строку подключения здесь и
// в `scripts/test-int.mjs`. Реэкспорт сохраняет прежний публичный API модуля (его импортируют тесты).
export { logTail, splitDatabaseUrl, withDatabase };

/** Prisma CLI пакета `api`: там он и установлен, и оттуда виден `prisma.config.ts`. */
const API_DIR = join('apps', 'api');
const PRISMA_BIN = join(API_DIR, 'node_modules', '.bin', 'prisma');

/**
 * Имя временной базы гейта `migrations_clean`: `<database>_gate_<pid>_<время в base36>`.
 * @param {string} database имя базы из `DATABASE_URL`
 * @param {{ pid?: number, now?: number }} [options]
 * @returns {string}
 */
export function gateDatabaseName(database, options = {}) {
  return temporaryDatabaseName(database, { ...options, marker: 'gate' });
}

/**
 * Проверка на пустой БД: создать базу, применить миграции, убедиться в отсутствии
 * неприменённых, удалить базу.
 * @param {{
 *   url: string,
 *   root: string,
 *   log: (line: string) => void,
 *   now?: number,
 *   pid?: number,
 *   execute?: (args: string[], options: { url: string, input?: string }) => { ok: boolean, exit: number|null, output: string },
 * }} options
 * @returns {{ ok: boolean, database: string }}
 */
export function runCleanMigrations({
  url,
  root,
  log,
  now = Date.now(),
  pid = process.pid,
  execute = createPrismaExecutor(root),
}) {
  const { database } = splitDatabaseUrl(url);
  const gateDatabase = gateDatabaseName(database, { pid, now });
  const gateUrl = withDatabase(url, gateDatabase);
  const adminUrl = withDatabase(url, MAINTENANCE_DATABASE);

  log(`migrations_clean: временная база ${gateDatabase}`);

  const create = execute(['db', 'execute', '--stdin'], {
    url: adminUrl,
    input: `CREATE DATABASE "${gateDatabase}"`,
  });
  if (!create.ok) {
    log(`migrations_clean: CREATE DATABASE — код ${create.exit}`);
    log(logTail(create.output));
    return { ok: false, database: gateDatabase };
  }

  try {
    const deploy = execute(['migrate', 'deploy'], { url: gateUrl });
    log(`migrations_clean: prisma migrate deploy — код ${deploy.exit}`);
    if (!deploy.ok) {
      log(logTail(deploy.output));
      return { ok: false, database: gateDatabase };
    }

    // `migrate status` подтверждает, что применено всё и расхождений нет: deploy
    // выходит с нулём и тогда, когда применять было нечего.
    const status = execute(['migrate', 'status'], { url: gateUrl });
    log(`migrations_clean: prisma migrate status — код ${status.exit}`);
    if (!status.ok) {
      log(logTail(status.output));
      return { ok: false, database: gateDatabase };
    }
    return { ok: true, database: gateDatabase };
  } finally {
    // Удаление — в любом исходе; ошибка уборки не меняет вердикт, но видна в логе.
    const drop = execute(['db', 'execute', '--stdin'], {
      url: adminUrl,
      input: `DROP DATABASE IF EXISTS "${gateDatabase}"`,
    });
    log(
      drop.ok
        ? `migrations_clean: временная база ${gateDatabase} удалена`
        : `migrations_clean: DROP DATABASE — код ${drop.exit} (база ${gateDatabase} осталась)`,
    );
  }
}

/**
 * Точка входа CLI: `DATABASE_URL` из окружения (как у `test_int`, `.env` не читается),
 * код возврата `0` — миграции применились на пустой БД, `1` — иначе.
 * @returns {void}
 */
function main() {
  const url = process.env.DATABASE_URL;
  if (typeof url !== 'string' || url.trim() === '') {
    process.stderr.write(
      'migrations_clean: DATABASE_URL не задан в окружении — проверка на чистой БД невозможна\n',
    );
    process.exitCode = 1;
    return;
  }

  const root = fileURLToPath(new URL('..', import.meta.url));
  if (!existsSync(join(root, PRISMA_BIN))) {
    process.stderr.write(`migrations_clean: не найден ${PRISMA_BIN} — выполните pnpm install\n`);
    process.exitCode = 1;
    return;
  }

  const result = runCleanMigrations({
    url,
    root,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  process.exitCode = result.ok ? 0 : 1;
}

// Модуль импортируется тестами ради чистых помощников; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
