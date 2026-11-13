#!/usr/bin/env node
/**
 * Проверка workflow GitHub Actions линтером `actionlint` (issue #65).
 *
 * Зачем: ошибки схемы (например, `permissions: packages: delete`) GitHub находит только
 * при попытке запустить workflow. Для файлов с триггерами `schedule`/`workflow_dispatch`
 * это значит, что ошибка живёт в `main` незамеченной (так и вышло в #63).
 *
 * Берёт линтер оттуда, где он есть:
 * 1. бинарник `actionlint` в PATH (быстрее всего);
 * 2. Docker-образ `rhysd/actionlint` (есть в CI и на dev-машине).
 * Если нет ни того, ни другого — предупреждение и код 0, чтобы не блокировать коммит.
 *
 * Запуск: `pnpm lint:workflows [файлы...]`. Без аргументов проверяет весь проект.
 * Версия образа закреплена; обновлять вместе с `rhysd/actionlint` releases.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ACTIONLINT_IMAGE = 'rhysd/actionlint:1.7.12';

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

  /** @type {{ command: string, args: string[] }} */
  let invocation;

  if (hasCommand('actionlint', ['--version'])) {
    invocation = { command: 'actionlint', args: ['-color', ...files] };
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
    };
  } else {
    console.warn('lint:workflows: ни actionlint, ни docker не найдены — проверка пропущена');
    return;
  }

  try {
    execFileSync(invocation.command, invocation.args, { stdio: 'inherit' });
    console.log('lint:workflows: workflow в порядке');
  } catch (error) {
    // Код возврата actionlint — это найденные проблемы; пробрасываем его вызывающему.
    process.exit(typeof error.status === 'number' ? error.status : 1);
  }
}

main();
