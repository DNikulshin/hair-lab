#!/usr/bin/env node
/**
 * Проверка Dockerfile и compose-файлов без сборки образа (issue #110).
 *
 * Зачем: ошибку в Dockerfile или compose сейчас ловит только фактическая сборка образа
 * (job `docker` в CI) — то есть после пуша и минуты работы. Дешёвые проверки нашлись
 * отдельно: `hadolint` для Dockerfile и `docker compose config` для compose (схема файла
 * и синтаксис интерполяции `$VAR` / `${VAR:?…}`).
 *
 * **hadolint** берётся в таком порядке:
 * 1. бинарник из PATH;
 * 2. скачивание с GitHub Releases закреплённой версии в кэш — основной путь в CI:
 *    не зависит от Docker Hub, который отдаёт 502 и лимитирует пуллы (так же, как
 *    `lint-workflows.mjs` обходится без `rhysd/actionlint`-образа);
 * 3. нет ни того, ни другого — предупреждение и пропуск проверки; в CI (`CI=1`) это отказ,
 *    иначе гейт молча зеленел бы без линтера.
 *
 * **compose** проверяется через `docker compose config --quiet --no-interpolate`:
 * без интерполяции нужны только схема и структура, поэтому подставлять значения
 * переменных не приходится, а секреты в проверку не попадают. Docker в этом окружении
 * бывает недоступен (dev-машина без CLI) — тогда проверка пропускается с предупреждением;
 * в CI Docker есть, и пропуск считается отказом.
 *
 * Запуск: `pnpm lint:docker [файлы...]`. Без аргументов проверяет `apps/<app>/Dockerfile*`
 * и compose-файлы в корне. Отладка: `FORCE_HADOLINT_DOWNLOAD=1` — пропустить PATH.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Версия линтера: одна на кэш и на скачивание. Обновлять вместе с релизом hadolint. */
export const HADOLINT_VERSION = '2.12.0';

/** Compose-файлы проекта: локальная разработка и прод-контур. */
export const COMPOSE_FILES = Object.freeze(['docker-compose.yml', 'docker-compose.prod.yml']);

/**
 * Каталог кэша скачанного бинарника: переживает прогоны CI в пределах машины.
 * @returns {string}
 */
export function cacheDir() {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(base, 'hair-lab', 'hadolint', HADOLINT_VERSION);
}

/**
 * Имя ассета релиза hadolint для текущей платформы.
 * @returns {string|null} null — платформа без готового бинарника
 */
export function releaseAsset() {
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'arm64' : null;
  const platform =
    process.platform === 'linux' ? 'Linux' : process.platform === 'darwin' ? 'Darwin' : null;
  if (arch === null || platform === null) return null;
  return `hadolint-${platform}-${arch}`;
}

/**
 * Скачивает бинарник в кэш (если его там нет).
 * @returns {{ path: string, fromCache: boolean }|null} null — получить не удалось
 */
function downloadHadolint() {
  const asset = releaseAsset();
  if (asset === null) return null;

  const binary = join(cacheDir(), 'hadolint');
  if (existsSync(binary)) return { path: binary, fromCache: true };

  const url = `https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/${asset}`;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    console.log(`lint:docker: скачиваю hadolint ${HADOLINT_VERSION} (${url})`);
    execFileSync('curl', ['-sSL', '--fail', '-o', binary, url], { stdio: 'inherit' });
    execFileSync('chmod', ['+x', binary], { stdio: 'ignore' });
    return existsSync(binary) ? { path: binary, fromCache: false } : null;
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.warn(`lint:docker: скачивание hadolint не удалось (${detail})`);
    return null;
  }
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {boolean}
 */
function hasCommand(command, args) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Dockerfile'ы проекта: `apps/<app>/Dockerfile` и варианты вида `Dockerfile.prod`.
 * @param {string} root корень репозитория
 * @returns {string[]} пути относительно корня, отсортированные
 */
export function dockerfiles(root) {
  const appsDir = join(root, 'apps');
  if (!existsSync(appsDir)) return [];
  /** @type {string[]} */
  const found = [];
  for (const app of readdirSync(appsDir, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const dir = join(appsDir, app.name);
    for (const file of readdirSync(dir)) {
      if (!file.startsWith('Dockerfile')) continue;
      found.push(join('apps', app.name, file));
    }
  }
  return found.sort();
}

/**
 * compose-файлы, которые есть в репозитории.
 * @param {string} root корень репозитория
 * @returns {string[]}
 */
export function composeFiles(root) {
  return COMPOSE_FILES.filter((file) => existsSync(join(root, file)));
}

/**
 * Провайдер бинарника hadolint: PATH → кэш/скачивание → null.
 * @param {{ forceDownload?: boolean }} [options]
 * @returns {{ command: string, source: string }|null}
 */
function resolveHadolint({ forceDownload = false } = {}) {
  if (!forceDownload && hasCommand('hadolint', ['--version'])) {
    return { command: 'hadolint', source: 'PATH' };
  }
  const downloaded = downloadHadolint();
  if (downloaded === null) return null;
  return {
    command: downloaded.path,
    source: downloaded.fromCache ? 'кэш скачанного бинарника' : 'скачивание с GitHub Releases',
  };
}

/**
 * Проверка Dockerfile'ов. Существование линтера в CI обязательно: иначе гейт зелёный
 * без проверки, а это хуже отсутствия гейта.
 * @param {string[]} files
 * @param {{
 *   ci: boolean,
 *   forceDownload?: boolean,
 *   locate?: (options: { forceDownload?: boolean }) => { command: string, source: string }|null,
 *   run?: (command: string, args: string[], options: { stdio: string }) => unknown,
 * }} options
 * @returns {number} 0 — ошибок нет; 1 — находки или (в CI) нет линтера
 */
export function checkDockerfiles(
  files,
  { ci, forceDownload = false, locate = resolveHadolint, run = execFileSync },
) {
  if (files.length === 0) {
    console.log('lint:docker: Dockerfile не найдены — проверять нечего');
    return 0;
  }

  const hadolint = locate({ forceDownload });
  if (hadolint === null) {
    const message =
      'lint:docker: hadolint недоступен (нет в PATH, скачивание не удалось) — проверка Dockerfile пропущена';
    if (ci) {
      console.error(`${message}; в CI это отказ`);
      return 1;
    }
    console.warn(message);
    return 0;
  }

  console.log(`lint:docker: hadolint ${HADOLINT_VERSION} — источник: ${hadolint.source}`);
  try {
    run(hadolint.command, files, { stdio: 'inherit' });
    console.log(`lint:docker: Dockerfile в порядке (${files.join(', ')})`);
    return 0;
  } catch (error) {
    // Код возврата hadolint — найденные проблемы; пробрасываем его вызывающему.
    return typeof error.status === 'number' ? error.status : 1;
  }
}

/**
 * Проверка compose-файлов без интерполяции: схема и структура. Значения переменных
 * не подставляются, поэтому секреты и `.env*` в проверке не участвуют.
 * @param {string} root корень репозитория
 * @param {string[]} files
 * @param {{
 *   ci: boolean,
 *   hasDocker?: () => boolean,
 *   run?: (command: string, args: string[], options: { cwd: string, stdio: string }) => unknown,
 * }} options
 * @returns {number} 0 — ошибок нет; 1 — находки или (в CI) нет docker
 */
export function checkCompose(
  root,
  files,
  { ci, hasDocker = () => hasCommand('docker', ['compose', 'version']), run = execFileSync },
) {
  if (files.length === 0) {
    console.log('lint:docker: compose-файлов нет — проверять нечего');
    return 0;
  }

  if (!hasDocker()) {
    const message = 'lint:docker: docker compose не найден — проверка compose-файлов пропущена';
    if (ci) {
      console.error(`${message}; в CI это отказ`);
      return 1;
    }
    console.warn(message);
    return 0;
  }

  let code = 0;
  for (const file of files) {
    try {
      run('docker', ['compose', '-f', file, 'config', '--quiet', '--no-interpolate'], {
        cwd: root,
        stdio: 'inherit',
      });
      console.log(`lint:docker: ${file} — схема в порядке`);
    } catch (error) {
      code = typeof error.status === 'number' ? error.status : 1;
    }
  }
  return code;
}

function main() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  process.chdir(root);

  // Явные аргументы CLI (pre-commit передаёт staged-файлы) фильтруются по типу:
  // Dockerfile'ы и compose-файлы проверяются разными инструментами.
  const args = process.argv
    .slice(2)
    .map((file) => relative(root, resolve(root, file.trim())))
    .filter((file) => file.length > 0 && existsSync(resolve(root, file)));

  const dockerFileArgs = args.filter((file) => file.includes('Dockerfile'));
  const composeFileArgs = args.filter((file) => COMPOSE_FILES.includes(file));

  const ci = process.env.CI === 'true' || process.env.CI === '1';
  const files = dockerFileArgs.length > 0 ? dockerFileArgs : dockerfiles(root);
  const composes = composeFileArgs.length > 0 ? composeFileArgs : composeFiles(root);

  const dockerfileCode = checkDockerfiles(files, {
    ci,
    forceDownload: process.env.FORCE_HADOLINT_DOWNLOAD === '1',
  });
  const composeCode = checkCompose(root, composes, { ci });

  if (dockerfileCode !== 0 || composeCode !== 0)
    process.exit(dockerfileCode === 0 ? composeCode : dockerfileCode);
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
