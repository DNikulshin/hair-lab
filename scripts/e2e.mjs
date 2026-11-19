#!/usr/bin/env node
/**
 * Стенд для браузерных тестов (issue #114): временная БД → сборка → api + заглушка ЮKassa → web.
 *
 * Почему отдельный скрипт, а не docker compose: в CI нужен минимум движущихся частей.
 * Схема та же, что у `pnpm test:int` (#89) — база создаётся на прогон и удаляется в `finally`,
 * поэтому E2E не читает и не портит dev-данные. Прод-код не меняется: оплата включается
 * через `PAYMENTS_MODE=test` и `YOOKASSA_API_URL`, которые и раньше читались из окружения.
 *
 * Шаги (`E2E_SKIP_BUILD=1` пропускает сборки, когда они уже сделаны):
 * 1. `CREATE DATABASE <db>_e2e_<pid>_<время>` → `prisma migrate deploy` → `e2e/seed.sql`;
 * 2. `pnpm --filter @hair-lab/web build` (production, `NEXT_PUBLIC_API_URL` на локальный api)
 *    и `pnpm --filter @hair-lab/api build`;
 * 3. статика и `public` из `.next` докладываются в standalone-каталог (иначе страницы без CSS);
 * 4. процессы: заглушка ЮKassa (`e2e/yookassa-stub.mjs`), api (`dist/main.js`), web
 *    (`standalone/apps/web/server.js`); ждём `/health` и `/`;
 * 5. `playwright test -c e2e/playwright.config.ts`.
 *
 * Teardown гасит процессы и удаляет базу; `E2E_KEEP=1` оставляет и то, и другое для отладки.
 * Коды возврата: 0 — тесты прошли, 1 — упали тесты или стенд не поднялся, 2 — нет окружения.
 *
 * Shebang нужен: файл запускается напрямую (`pnpm e2e`).
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPrismaExecutor,
  logTail,
  splitDatabaseUrl,
  temporaryDatabaseName,
  withDatabase,
} from './lib/db-url.mjs';

/** Порты стенда: те же, что в рецепте `docs/qa-web.md`, чтобы инструкции не расходились. */
export const PORTS = Object.freeze({ api: 3001, web: 3003, stub: 3999 });

/** Сколько ждать готовности сервиса, мс. */
const READY_TIMEOUT_MS = 90_000;

/**
 * Переменные api для стенда: оплата включена, шлюз — заглушка, свипер тикает часто.
 * @param {{ databaseUrl: string }} options
 * @returns {NodeJS.ProcessEnv}
 */
export function apiEnv({ databaseUrl, caPath }) {
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    // Заглушка отдаёт TLS с самоподписанным сертификатом: api доверяет ему как CA,
    // проверка TLS при этом остаётся включённой.
    NODE_EXTRA_CA_CERTS: caPath,
    API_PORT: String(PORTS.api),
    API_HOST: '127.0.0.1',
    LOG_LEVEL: 'warn',
    PAYMENTS_MODE: 'test',
    // Заглушка подменяет провайдера: ключи не проверяются, но обязательны при `test`.
    YOOKASSA_SHOP_ID: 'e2e-shop',
    YOOKASSA_SECRET_KEY: 'e2e-secret',
    YOOKASSA_API_URL: `https://127.0.0.1:${PORTS.stub}/v3`,
    APP_URL: `http://127.0.0.1:${PORTS.web}`,
    CORS_ORIGINS: `http://127.0.0.1:${PORTS.web}`,
    // Холд истекает быстро только в тестах: сценарий оплаты не должен ждать 15 минут.
    PAYMENT_SWEEP_INTERVAL_MS: '1000',
    // Почта в стенде выключена: письма остаются в outbox, наружу ничего не уходит.
    SMTP_HOST: '',
  };
}

/**
 * Переменные web-сборки: api того же стенда и никаких прокси-префиксов из dev-окружения
 * (иначе Next вшивает `/absproxy/<port>` и все страницы отвечают 404).
 * @returns {NodeJS.ProcessEnv}
 */
export function webBuildEnv() {
  return {
    ...process.env,
    NEXT_BASE_PATH: '',
    NEXT_ASSET_PREFIX: '',
    NEXT_PUBLIC_API_URL: `http://127.0.0.1:${PORTS.api}`,
    NEXT_TELEMETRY_DISABLED: '1',
  };
}

/**
 * Ждёт, пока сервис начнёт отвечать 2xx/3xx.
 * @param {string} url
 * @param {{ timeoutMs?: number, isCanceled?: () => boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function waitForReady(
  url,
  { timeoutMs = READY_TIMEOUT_MS, isCanceled = () => false } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isCanceled()) return false;
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 400) return true;
    } catch {
      // Сервис ещё не слушает: ждём дальше.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  return false;
}

/**
 * Свободен ли порт: занятый порт — понятная ошибка вместо «address already in use» из глубины.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function portIsFree(port) {
  return new Promise((resolveProbe) => {
    const probe = createServer();
    probe.once('error', () => resolveProbe(false));
    probe.once('listening', () => probe.close(() => resolveProbe(true)));
    probe.listen(port, '127.0.0.1');
  });
}

/**
 * Запускает дочерний процесс с наследованием вывода.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 */
function startProcess(command, args, { cwd, env }) {
  return spawn(command, args, { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
}

/**
 * Запускает шаг и ждёт его завершения.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 * @returns {Promise<number|null>}
 */
function runStep(command, args, { cwd, env }) {
  return new Promise((resolveStep) => {
    const child = startProcess(command, args, { cwd, env });
    child.on('exit', (code) => resolveStep(code));
  });
}

/**
 * @param {{ root: string, log: (line: string) => void }} options
 * @returns {Promise<number>} код возврата
 */
export async function runE2E({ root, log }) {
  const url = process.env.DATABASE_URL;
  if (typeof url !== 'string' || url.trim() === '') {
    log('e2e: DATABASE_URL не задан в окружении — временную базу не из чего создать');
    return 2;
  }

  const skipBuild = process.env.E2E_SKIP_BUILD === '1';
  const keep = process.env.E2E_KEEP === '1';

  for (const [name, port] of Object.entries(PORTS)) {
    if (!(await portIsFree(port))) {
      log(`e2e: порт ${port} (${name}) занят — остановите предыдущий стенд`);
      return 2;
    }
  }

  const { database } = splitDatabaseUrl(url);
  const e2eDatabase = temporaryDatabaseName(database, { marker: 'e2e' });
  const e2eUrl = withDatabase(url, e2eDatabase);
  const adminUrl = withDatabase(url, 'postgres');
  const execute = createPrismaExecutor(root);

  const create = execute(['db', 'execute', '--stdin'], {
    url: adminUrl,
    input: `CREATE DATABASE "${e2eDatabase}"`,
  });
  if (!create.ok) {
    log(`e2e: CREATE DATABASE — код ${create.exit}`);
    log(logTail(create.output));
    return 1;
  }
  log(`e2e: временная база ${e2eDatabase}`);

  /** @type {import('node:child_process').ChildProcess[]} */
  const children = [];
  const stop = () => {
    for (const child of children) child.kill('SIGTERM');
    children.length = 0;
  };

  try {
    const deploy = execute(['migrate', 'deploy'], { url: e2eUrl });
    log(`e2e: prisma migrate deploy — код ${deploy.exit}`);
    if (!deploy.ok) {
      log(logTail(deploy.output));
      return 1;
    }

    const seedPath = join(root, 'e2e', 'seed.sql');
    const seed = execute(['db', 'execute', '--file', seedPath], { url: e2eUrl });
    log(`e2e: seed — код ${seed.exit}`);
    if (!seed.ok) {
      log(logTail(seed.output));
      return 1;
    }

    if (!skipBuild) {
      const webBuild = await runStep('pnpm', ['--filter', '@hair-lab/web', 'build'], {
        cwd: root,
        env: webBuildEnv(),
      });
      log(`e2e: сборка web — код ${webBuild}`);
      if (webBuild !== 0) return 1;

      const apiBuild = await runStep('pnpm', ['--filter', '@hair-lab/api', 'build'], {
        cwd: root,
        env: process.env,
      });
      log(`e2e: сборка api — код ${apiBuild}`);
      if (apiBuild !== 0) return 1;
    }

    // standalone-вывод не содержит статики и `public`: без них браузер получит страницы без CSS.
    const standalone = join(root, 'apps', 'web', '.next', 'standalone', 'apps', 'web');
    cpSync(join(root, 'apps', 'web', '.next', 'static'), join(standalone, '.next', 'static'), {
      recursive: true,
    });
    cpSync(join(root, 'apps', 'web', 'public'), join(standalone, 'public'), { recursive: true });

    const tlsDir = mkdtempSync(join(tmpdir(), 'hair-lab-e2e-tls-'));
    const caPath = join(tlsDir, 'cert.pem');
    const stub = startProcess(process.execPath, [join(root, 'e2e', 'yookassa-stub.mjs')], {
      cwd: root,
      env: { ...process.env, E2E_TLS_DIR: tlsDir },
    });
    children.push(stub);

    // Ждём сертификат: api стартует с `NODE_EXTRA_CA_CERTS` и без файла не поверит заглушке.
    const certDeadline = Date.now() + 15_000;
    while (!existsSync(caPath) && Date.now() < certDeadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    }
    if (!existsSync(caPath)) {
      log('e2e: заглушка не отдала сертификат — стенд не поднят');
      return 1;
    }

    const api = startProcess(process.execPath, [join(root, 'apps', 'api', 'dist', 'main.js')], {
      cwd: join(root, 'apps', 'api'),
      env: apiEnv({ databaseUrl: e2eUrl, caPath }),
    });
    children.push(api);
    const web = startProcess(process.execPath, ['server.js'], {
      cwd: standalone,
      env: {
        ...process.env,
        PORT: String(PORTS.web),
        HOSTNAME: '127.0.0.1',
        NEXT_PUBLIC_API_URL: `http://127.0.0.1:${PORTS.api}`,
      },
    });
    children.push(web);

    const apiReady = await waitForReady(`http://127.0.0.1:${PORTS.api}/health`);
    const webReady = await waitForReady(`http://127.0.0.1:${PORTS.web}/`);
    log(
      `e2e: api ${apiReady ? 'готов' : 'НЕ поднялся'}, web ${webReady ? 'готов' : 'НЕ поднялся'}`,
    );
    if (!apiReady || !webReady) return 1;

    const tests = await runStep(
      'pnpm',
      ['exec', 'playwright', 'test', '-c', 'e2e/playwright.config.ts'],
      {
        cwd: root,
        env: {
          ...process.env,
          E2E_BASE_URL: `http://127.0.0.1:${PORTS.web}`,
          E2E_API_URL: `http://127.0.0.1:${PORTS.api}`,
        },
      },
    );
    log(`e2e: браузерные тесты — код ${tests}`);
    return tests === 0 ? 0 : 1;
  } finally {
    if (keep) {
      log(`e2e: E2E_KEEP=1 — стенд оставлен, база ${e2eDatabase} не удалена`);
    } else {
      stop();
      const drop = execute(['db', 'execute', '--stdin'], {
        url: adminUrl,
        input: `DROP DATABASE IF EXISTS "${e2eDatabase}"`,
      });
      log(
        drop.ok
          ? `e2e: временная база ${e2eDatabase} удалена`
          : `e2e: DROP DATABASE — код ${drop.exit} (база ${e2eDatabase} осталась)`,
      );
    }
  }
}

/**
 * Точка входа CLI.
 * @returns {Promise<void>}
 */
async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  if (!existsSync(join(root, 'apps', 'api', 'node_modules', '.bin', 'prisma'))) {
    process.stderr.write('e2e: не найден prisma — выполните pnpm install\n');
    process.exitCode = 2;
    return;
  }
  if (!existsSync(join(root, 'node_modules', '@playwright', 'test'))) {
    process.stderr.write('e2e: не установлен @playwright/test — выполните pnpm install\n');
    process.exitCode = 2;
    return;
  }

  const code = await runE2E({ root, log: (line) => process.stdout.write(`${line}\n`) });
  process.exitCode = code;
}

// Модуль импортируется тестами ради чистых помощников; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
