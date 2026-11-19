#!/usr/bin/env node
/**
 * Проверка workflow GitHub Actions линтером `actionlint` и shell-синтаксиса run-блоков
 * (issue #65, #146).
 *
 * Зачем: ошибки схемы (например, `permissions: packages: delete`) GitHub находит только
 * при попытке запустить workflow. Для файлов с триггерами `schedule`/`workflow_dispatch`
 * это значит, что ошибка живёт в `main` незамеченной (так и вышло в #63).
 *
 * **Shell-синтаксис.** actionlint проверяет run-блоки через shellcheck, но локально shellcheck
 * недоступен (бинарника нет в PATH, скачивание с GitHub Releases режется сетью), поэтому
 * локальный гейт был слабее CI и расхождение выяснялось только на PR (#145, SC1072).
 * Замена — `bash -n` по каждому run-блоку (`scripts/lib/workflow-runs.mjs`): разбор YAML,
 * `${{ … }}` → `EXPR`, проверка синтаксиса во временном файле. Шаги с чужим `shell:`
 * (`python`, `pwsh`) не проверяются: там не bash. Когда shellcheck появится в окружении,
 * его можно включить дополнительно; `bash -n` остаётся самым дешёвым локальным гейтом.
 *
 * Берёт линтер в таком порядке:
 * 1. бинарник `actionlint` в PATH;
 * 2. скачивание архива с GitHub Releases (той же закреплённой версии) в кэш-каталог —
 *    основной путь в CI: не зависит от доступности Docker Hub, который отдаёт 502 и лимитирует пуллы;
 * 3. Docker-образ `rhysd/actionlint` (fallback: GitHub недоступен, но Docker есть).
 * Нет ни одного источника — предупреждение, shell-проверка всё равно выполняется.
 *
 * Запуск: `pnpm lint:workflows [файлы...]`. Без аргументов проверяет весь проект.
 * Версия закреплена (`LOCAL_VERSION`); обновлять вместе с `rhysd/actionlint` releases.
 * Отладка: `FORCE_ACTIONLINT_DOWNLOAD=1` — пропустить PATH и проверить скачивание.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractRunBlocks, isBashShell } from './lib/workflow-runs.mjs';

/** Версия линтера: одно значение для архива и Docker-образа. */
const ACTIONLINT_VERSION = '1.7.12';
const ACTIONLINT_IMAGE = `rhysd/actionlint:${ACTIONLINT_VERSION}`;

/** Кэш скачанного бинарника: переживает прогоны CI в пределах машины. */
function cacheDir() {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(base, 'hair-lab', 'actionlint', ACTIONLINT_VERSION);
}

/** Платформа в терминах релизов actionlint: linux/darwin × amd64/arm64. */
function releasePlatform() {
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;
  const platform =
    process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : null;
  if (arch === null || platform === null) return null;
  return { platform, arch };
}

/**
 * Берёт бинарник из кэша или скачивает архив релиза.
 * @returns {{ path: string, fromCache: boolean } | null} null — получить не удалось
 */
function downloadActionlint() {
  const target = releasePlatform();
  if (target === null) return null;

  const binary = join(cacheDir(), 'actionlint');
  if (existsSync(binary)) return { path: binary, fromCache: true };

  const asset = `actionlint_${ACTIONLINT_VERSION}_${target.platform}_${target.arch}.tar.gz`;
  const url = `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/${asset}`;

  try {
    mkdirSync(cacheDir(), { recursive: true });
    const archive = join(cacheDir(), asset);
    console.log(`lint:workflows: скачиваю actionlint ${ACTIONLINT_VERSION} (${url})`);
    execFileSync('curl', ['-sSL', '--fail', '-o', archive, url], { stdio: 'inherit' });
    // Архив содержит один бинарник `actionlint` в корне.
    execFileSync('tar', ['-xzf', archive, '-C', cacheDir()], { stdio: 'inherit' });
    return existsSync(binary) ? { path: binary, fromCache: false } : null;
  } catch (error) {
    console.warn(
      `lint:workflows: скачивание не удалось (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`,
    );
    return null;
  }
}

function hasCommand(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Файлы workflow из аргументов CLI или, если их нет, весь каталог `.github/workflows`.
 * Пути остаются относительными (в таком виде их ждёт actionlint), читаются относительно
 * текущего каталога — `main` уже перешёл в корень репозитория.
 * @param {string} root корень репозитория
 * @returns {string[]}
 */
export function workflowFiles(root) {
  const args = process.argv
    .slice(2)
    .map((file) => file.trim())
    .filter((file) => file.length > 0 && existsSync(resolve(root, file)));
  if (args.length > 0) return args;

  const dir = join(root, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => join('.github', 'workflows', name));
}

/**
 * Проверяет shell-синтаксис каждого `run:`-блока через `bash -n` (issue #146).
 * `${{ … }}` уже заменены на `EXPR` (`scripts/lib/workflow-runs.mjs`), шаги с чужим
 * `shell:` (`python`, `pwsh`) пропускаются. Номера строк в выводе bash пересчитываются
 * в строки workflow.
 * @param {string[]} files пути workflow-файлов (относительные или абсолютные)
 * @returns {number} 0 — ошибок нет; 1 — хотя бы один блок не проходит `bash -n`
 */
export function checkShellSyntax(files) {
  if (!hasCommand('bash', ['-c', 'true'])) {
    console.warn('lint:workflows: bash не найден — shell-проверка run-блоков пропущена');
    return 0;
  }

  const dir = mkdtempSync(join(tmpdir(), 'hair-lab-workflow-shell-'));
  let checked = 0;
  let skipped = 0;
  /** @type {string[]} */
  const failures = [];

  try {
    for (const file of files) {
      const blocks = extractRunBlocks(readFileSync(resolve(file), 'utf8'), { file });
      for (const block of blocks) {
        if (!isBashShell(block.shell)) {
          skipped += 1;
          continue;
        }
        if (block.script.trim() === '') continue;

        const target = join(dir, `run-${checked + 1}.sh`);
        writeFileSync(target, `${block.script}\n`, 'utf8');
        checked += 1;

        try {
          execFileSync('bash', ['-n', target], { stdio: 'pipe' });
        } catch (error) {
          const stderr = error instanceof Error ? String(error.stderr ?? error.message) : '';
          const detail = stderr
            .replaceAll(target, block.file)
            .replace(/line (\d+)/g, (_, line) => `line ${block.line + Number(line) - 1}`)
            .trim();
          const where = [
            block.job === null ? null : `job «${block.job}»`,
            block.step === null ? null : `шаг «${block.step}»`,
          ]
            .filter((part) => part !== null)
            .join(', ');
          failures.push(
            `lint:workflows: ${block.file}:${block.line}${where === '' ? '' : ` (${where})`} — bash -n:\n${detail}`,
          );
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    console.error(
      `lint:workflows: shell-синтаксис — ошибок ${failures.length} (проверено блоков ${checked})`,
    );
    return 1;
  }

  console.log(
    `lint:workflows: shell-синтаксис run-блоков в порядке (проверено ${checked}${
      skipped === 0 ? '' : `, пропущено с чужим shell: ${skipped}`
    })`,
  );
  return 0;
}

/**
 * Прогон actionlint: PATH → скачанный бинарник → Docker. Нет источника — предупреждение
 * и код 0 (shell-проверка ниже всё равно выполняется).
 * @param {string} root корень репозитория
 * @param {string[]} files
 * @returns {number}
 */
function runActionlint(root, files) {
  const forceDownload = process.env.FORCE_ACTIONLINT_DOWNLOAD === '1';

  /** @type {{ command: string, args: string[], source: string }|null} */
  let invocation = null;

  if (!forceDownload && hasCommand('actionlint', ['--version'])) {
    invocation = { command: 'actionlint', args: ['-color', ...files], source: 'PATH' };
  } else {
    const downloaded = downloadActionlint();
    if (downloaded !== null) {
      invocation = {
        command: downloaded.path,
        args: ['-color', ...files],
        source: downloaded.fromCache ? 'кэш скачанного бинарника' : 'скачивание с GitHub Releases',
      };
    } else if (hasCommand('docker', ['--version'])) {
      // Каталог проекта монтируется целиком: actionlint ищет `.github/workflows` и git-корень.
      invocation = {
        command: 'docker',
        args: [
          'run',
          '--rm',
          '-v',
          `${root}:/repo`,
          '-w',
          '/repo',
          ACTIONLINT_IMAGE,
          '-color',
          ...files,
        ],
        source: 'docker',
      };
    }
  }

  if (invocation === null) {
    console.warn(
      'lint:workflows: ни actionlint, ни скачивание, ни docker — YAML-проверка пропущена',
    );
    return 0;
  }

  console.log(`lint:workflows: источник — ${invocation.source}`);

  try {
    execFileSync(invocation.command, invocation.args, { stdio: 'inherit' });
    console.log('lint:workflows: workflow в порядке');
    return 0;
  } catch (error) {
    // Код возврата actionlint — это найденные проблемы; пробрасываем его вызывающему.
    return typeof error.status === 'number' ? error.status : 1;
  }
}

function main() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  process.chdir(root);

  const files = workflowFiles(root);
  if (files.length === 0) {
    console.log('lint:workflows: нет файлов workflow — проверять нечего');
    return;
  }

  // Обе проверки выполняются независимо: YAML-схема и shell-синтаксис ловят разное.
  const actionlintCode = runActionlint(root, files);
  const shellCode = checkShellSyntax(files);

  if (actionlintCode !== 0 || shellCode !== 0)
    process.exit(actionlintCode === 0 ? shellCode : actionlintCode);
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
