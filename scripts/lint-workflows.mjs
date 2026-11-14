#!/usr/bin/env node
/**
 * Проверка workflow GitHub Actions линтером `actionlint` (issue #65).
 *
 * Зачем: ошибки схемы (например, `permissions: packages: delete`) GitHub находит только
 * при попытке запустить workflow. Для файлов с триггерами `schedule`/`workflow_dispatch`
 * это значит, что ошибка живёт в `main` незамеченной (так и вышло в #63).
 *
 * Берёт линтер в таком порядке:
 * 1. бинарник `actionlint` в PATH;
 * 2. скачивание архива с GitHub Releases (той же закреплённой версии) в кэш-каталог —
 *    основной путь в CI: не зависит от доступности Docker Hub, который отдаёт 502 и лимитирует пуллы;
 * 3. Docker-образ `rhysd/actionlint` (fallback: GitHub недоступен, но Docker есть).
 * Если нет ни одного источника — предупреждение и код 0, чтобы не блокировать коммит.
 *
 * Запуск: `pnpm lint:workflows [файлы...]`. Без аргументов проверяет весь проект.
 * Версия закреплена (`LOCAL_VERSION`); обновлять вместе с `rhysd/actionlint` releases.
 * Отладка: `FORCE_ACTIONLINT_DOWNLOAD=1` — пропустить PATH и проверить скачивание.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

function main() {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  process.chdir(root);

  const files = process.argv
    .slice(2)
    .map((file) => file.trim())
    .filter((file) => file.length > 0 && existsSync(resolve(root, file)));

  const forceDownload = process.env.FORCE_ACTIONLINT_DOWNLOAD === '1';

  /** @type {{ command: string, args: string[], source: string }} */
  let invocation;

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
    } else {
      console.warn('lint:workflows: ни actionlint, ни скачивание, ни docker — проверка пропущена');
      return;
    }
  }

  console.log(`lint:workflows: источник — ${invocation.source}`);

  try {
    execFileSync(invocation.command, invocation.args, { stdio: 'inherit' });
    console.log('lint:workflows: workflow в порядке');
  } catch (error) {
    // Код возврата actionlint — это найденные проблемы; пробрасываем его вызывающему.
    process.exit(typeof error.status === 'number' ? error.status : 1);
  }
}

main();
