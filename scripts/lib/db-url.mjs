/**
 * Помощники для строк подключения к Postgres и временных баз (#250, #89).
 *
 * Зачем отдельный модуль: имя базы и «шапку» строки подключения разбирают два скрипта —
 * `migrations-clean.mjs` (гейт на чистой БД) и `test-int.mjs` (прогон интеграционных тестов
 * на временной базе). Копия этих правил разошлась бы при первой правке, а с ней и поведение
 * «в какой базе шли тесты».
 *
 * Секреты: сюда попадает только строка подключения; наружу она не печатается — в логах
 * фигурируют имя базы, коды выхода и хвост вывода после маскирования (`logTail`).
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { redactLog } from './cycle/redact.mjs';

/** Предел длины идентификатора в PostgreSQL, байт. */
export const MAX_IDENTIFIER_BYTES = 63;

/** Обслуживающая БД для `CREATE`/`DROP DATABASE`: она есть в любом образе Postgres. */
export const MAINTENANCE_DATABASE = 'postgres';

/** Сколько строк хвоста вывода попадает в лог при падении. */
const TAIL_LINES = 40;

/**
 * Разбирает строку подключения на базу и «шапку» без имени базы.
 * @param {string} value `DATABASE_URL`
 * @returns {{ database: string, origin: string }}
 */
export function splitDatabaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('splitDatabaseUrl: ожидается непустая строка подключения');
  }
  const url = new URL(value);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (database === '') {
    throw new Error('splitDatabaseUrl: в DATABASE_URL не указана база данных');
  }
  return { database, origin: `${url.protocol}//${url.host}` };
}

/**
 * Строка подключения к другой базе того же сервера: учётные данные и параметры
 * (`?schema=…`) сохраняются, меняется только имя базы.
 * @param {string} value исходный `DATABASE_URL`
 * @param {string} database имя базы
 * @returns {string}
 */
export function withDatabase(value, database) {
  const url = new URL(value);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

/**
 * Имя временной базы: `<database>_<marker>_<pid>_<время в base36>`. Уникально для параллельных
 * прогонов (pid и время) и укладывается в 63 байта — длинное имя базы подрезается, хвост
 * с уникальной частью остаётся.
 * @param {string} database имя базы из `DATABASE_URL`
 * @param {{ marker: string, pid?: number, now?: number }} options `marker` — `gate` или `test`
 * @returns {string}
 */
export function temporaryDatabaseName(database, { marker, pid = process.pid, now = Date.now() }) {
  const suffix = `_${marker}_${pid}_${now.toString(36)}`;
  const room = MAX_IDENTIFIER_BYTES - Buffer.byteLength(suffix, 'utf8');
  // Подрезка по байтам, а не по символам: имя с кириллицей в UTF-8 занимает по два байта
  // на символ, и `slice` по длине строки перешёл бы предел идентификатора PostgreSQL.
  let prefix = '';
  for (const char of database) {
    if (Buffer.byteLength(prefix + char, 'utf8') > Math.max(room, 1)) break;
    prefix += char;
  }
  return `${prefix}${suffix}`;
}

/**
 * Хвост вывода без секретов: пароль и строка подключения в лог не попадают.
 * @param {string} text
 * @returns {string}
 */
export function logTail(text) {
  if (typeof text !== 'string') return '';
  const lines = text.trimEnd().split(/\r?\n/);
  return redactLog(lines.slice(-TAIL_LINES).join('\n'));
}

/**
 * Запуск Prisma CLI без оболочки: аргументы не склеиваются в строку, `DATABASE_URL`
 * подменяется в окружении дочернего процесса.
 * @param {string} root корень репозитория
 * @param {{ apiDir?: string }} [options]
 * @returns {(args: string[], options: { url: string, input?: string }) => { ok: boolean, exit: number|null, output: string }}
 */
export function createPrismaExecutor(root, { apiDir = join('apps', 'api') } = {}) {
  const prismaBin = join(apiDir, 'node_modules', '.bin', 'prisma');
  return (args, { url, input = '' }) => {
    const result = spawnSync(join(root, prismaBin), args, {
      cwd: join(root, apiDir),
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    return { ok: result.status === 0, exit: result.status, output };
  };
}
