#!/usr/bin/env node
/**
 * Создание сотрудника салона (первый вход в админку, issue #240).
 *
 * Зачем CLI, а не сид: учётная запись сотрудника — это доступ к админке. Сид с реальным
 * паролем в репозитории недопустим, поэтому пароль вводится один раз руками с терминала
 * (без эха) и в историю команд, в файлы и в логи не попадает. Пароль и его хеш скрипт
 * никуда не печатает — только id, почту и роль созданной записи.
 *
 * Запуск (корень репозитория, `DATABASE_URL` берётся из окружения процесса):
 *
 *   DATABASE_URL='postgresql://…' pnpm create:staff --email admin@example.invalid --role admin
 *
 * `.env*` скрипт не читает: переменную окружения экспортирует человек (осознанно и для той БД,
 * в которую пишет). Хеш — argon2id с параметрами из `apps/api/src/shared/auth/password.ts`
 * (OWASP, m=19456 KiB, t=2, p=1): параметры записаны в PHC-строке, поэтому их смена
 * не сломает проверку уже созданных хешей. Скрипт не импортирует TS-модуль API (root-скрипты
 * не проходят через tsx), поэтому параметры повторены здесь; тесты на сам скрипт не заводятся,
 * расхождение параметров безопасно для уже созданных хешей (см. ответ по задаче, follow-up).
 *
 * Идемпотентности нет и не нужно: повторная почта — ошибка 23505 с понятным текстом,
 * существующая запись не перезаписывается.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Зависимости берутся из воркспейса `apps/api`: в корне их нет и дублировать не нужно. */
const apiRequire = createRequire(join(ROOT, 'apps/api', 'package.json'));
const { hash } = apiRequire('@node-rs/argon2');
const { Client } = apiRequire('pg');

/** Параметры argon2id. Копия `ARGON2_OPTIONS` из `apps/api/src/shared/auth/password.ts`. */
const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

/** Роли — копия `staffRoleSchema` из `packages/contracts` (enum в БД `staff_role`). */
const ROLES = ['admin', 'manager'];

/** Длина пароля — как в `passwordSchema` контрактов. */
const PASSWORD_MIN_LENGTH = 10;
const PASSWORD_MAX_LENGTH = 128;

const USAGE = `Создание сотрудника (доступ в админку).

  pnpm create:staff --email <почта> [--role admin|manager]

  --email  почта сотрудника (обязательно), нормализуется: trim + нижний регистр;
  --role   роль: admin (полный доступ) или manager (по умолчанию);
  --help   эта справка.

DATABASE_URL берётся из окружения процесса (файлы .env скрипт не читает).
Пароль вводится с терминала без эха и в аргументах не передаётся.`;

/** Сообщение об ошибке без значений переменных окружения и без пароля. */
function fail(message) {
  console.error(`create:staff: ${message}`);
  process.exit(1);
}

/** Нормализация и проверка почты: та же нормализация, что в `emailSchema` контрактов. */
function normalizeEmail(raw) {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail('некорректная почта: ожидается адрес вида name@example.invalid');
  }
  return email;
}

/**
 * Чтение пароля с терминала без эха. Ввод только интерактивный: пароль не должен попадать
 * в аргументы командной строки, переменные окружения или пайп (они остаются в истории и логах).
 */
function readPassword(prompt) {
  if (!process.stdin.isTTY) {
    fail('пароль вводится с терминала: перенаправление ввода не поддерживается');
  }

  return new Promise((resolve, reject) => {
    const characters = [];
    const stdin = process.stdin;

    const finish = (error) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(characters.join(''));
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish(new Error('ввод отменён'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        // Backspace: символа на экране нет, но буфер чистим, чтобы исправление работало.
        if (character === '\u007f' || character === '\b') {
          characters.pop();
          continue;
        }
        characters.push(character);
      }
    };

    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function createStaff({ email, role, password, databaseUrl }) {
  const passwordHash = await hash(password, ARGON2_OPTIONS);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // `updated_at` проставляется явно: в схеме Prisma это `@updatedAt`, а БД дефолта не имеет.
    const { rows } = await client.query(
      `INSERT INTO "staff" ("id", "email", "password_hash", "role", "updated_at")
       VALUES ($1::uuid, $2, $3, $4, now())
       RETURNING "id", "email", "role"`,
      [randomUUID(), email, passwordHash, role],
    );
    return rows[0];
  } finally {
    await client.end();
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        email: { type: 'string' },
        role: { type: 'string', default: 'manager' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (error) {
    fail(`${error instanceof Error ? error.message : 'некорректные аргументы'}\n\n${USAGE}`);
  }

  if (parsed.values.help) {
    console.log(USAGE);
    return;
  }
  if (parsed.values.email === undefined || parsed.values.email.trim() === '') {
    fail(`не указана почта (--email)\n\n${USAGE}`);
  }
  const email = normalizeEmail(parsed.values.email);
  const role = parsed.values.role.trim().toLowerCase();
  if (!ROLES.includes(role)) {
    fail(`неизвестная роль "${role}": допустимы ${ROLES.join(', ')}`);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    fail('не задан DATABASE_URL: экспортируйте строку подключения в окружение процесса');
  }
  if (!databaseUrl.startsWith('postgresql://')) {
    fail('DATABASE_URL должен начинаться с postgresql://');
  }

  const password = await readPassword(`Пароль для ${email} (ввод не отображается): `);
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    fail(`пароль должен быть длиной ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} символов`);
  }

  let created;
  try {
    created = await createStaff({ email, role, password, databaseUrl });
  } catch (error) {
    // 23505 — нарушение уникального индекса `staff.email`: запись не перезаписываем.
    if (error?.code === '23505') {
      fail(`сотрудник с почтой ${email} уже есть: используйте другую почту`);
    }
    // Текст ошибки БД печатаем без строки подключения (она может содержать пароль).
    fail(`не удалось создать сотрудника: ${error?.message ?? 'неизвестная ошибка БД'}`);
  }

  console.log(`Сотрудник создан: id=${created.id} email=${created.email} role=${created.role}`);
}

await main();
