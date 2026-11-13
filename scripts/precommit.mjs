#!/usr/bin/env node
/**
 * Pre-commit проверка: форматирование, линт и границы слоёв по изменённым файлам.
 *
 * Запускается git-хуком `.githooks/pre-commit` (подключается `prepare`-скриптом:
 * `git config core.hooksPath .githooks`). Вручную: `pnpm precommit`.
 *
 * Правила:
 * - смотрим только файлы из индекса (staged), удалённые не проверяем;
 * - prettier и eslint запускаются с `--write`/`--fix`, исправленные файлы возвращаются в индекс;
 * - `.prettierignore` и `ignores` из eslint-конфига действуют как обычно (сгенерированное не трогаем);
 * - `check:arch` — только если тронуты `apps/<app>/src` или `packages/<pkg>/src`;
 * - `actionlint` — только если тронуты `.github/workflows/*.yml`;
 * - полный `typecheck` и тесты осознанно не запускаем: это делает CI, иначе коммит станет медленным.
 *
 * Хук обходится `git commit --no-verify`; правки не теряются — они уже в рабочем дереве.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const PRETTIER_FILES = /\.(?:md|mdx|json|jsonc|ya?ml|ts|tsx|mts|cts|js|jsx|mjs|cjs|css)$/;
const ESLINT_FILES = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const ARCH_FILES = /^(?:apps|packages)\/[^/]+\/src\//;
const WORKFLOW_FILES = /^\.github\/workflows\/.*\.ya?ml$/;

/** @param {string[]} args */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

/** @param {string} command @param {string[]} args */
function run(command, args, { allowFailure = false } = {}) {
  try {
    execFileSync(command, args, { stdio: 'inherit' });
    return 0;
  } catch (error) {
    if (allowFailure) return typeof error.status === 'number' ? error.status : 1;
    process.exit(typeof error.status === 'number' ? error.status : 1);
  }
}

/** @param {string[]} files */
function restage(files) {
  if (files.length === 0) return;
  git(['add', '--', ...files]);
}

/** @typedef {{ label: string, command: string, args: string[], files: string[] }} Step */

function main() {
  const root = git(['rev-parse', '--show-toplevel']).trim();
  process.chdir(root);

  if (!existsSync(resolve(root, 'node_modules/.bin/prettier'))) {
    console.log(
      'pre-commit: зависимости не установлены, проверка пропущена (нужен `pnpm install`)',
    );
    return;
  }

  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .split('\0')
    .filter((file) => file.length > 0 && existsSync(resolve(root, file)));

  if (staged.length === 0) {
    console.log('pre-commit: нет staged-файлов, пропускаем');
    return;
  }

  /** @type {Step[]} */
  const steps = [];

  const formatted = staged.filter((file) => PRETTIER_FILES.test(file));
  if (formatted.length > 0) {
    steps.push({
      label: 'prettier',
      command: 'pnpm',
      args: ['exec', 'prettier', '--write'],
      files: formatted,
    });
  }

  const linted = staged.filter((file) => ESLINT_FILES.test(file));
  if (linted.length > 0) {
    steps.push({
      label: 'eslint',
      command: 'pnpm',
      args: ['exec', 'eslint', '--fix', '--no-warn-ignored'],
      files: linted,
    });
  }

  for (const step of steps) {
    console.log(`pre-commit: ${step.label} — ${step.files.length} файл(ов)`);
    run(step.command, [...step.args, '--', ...step.files]);
    // Prettier и ESLint правят файлы на месте: возвращаем исправления в индекс.
    restage(step.files);
  }

  const workflows = staged.filter((file) => WORKFLOW_FILES.test(file));
  if (workflows.length > 0) {
    console.log(`pre-commit: actionlint — ${workflows.length} файл(ов)`);
    run('node', ['scripts/lint-workflows.mjs', ...workflows]);
  }

  const arch = staged.filter((file) => ARCH_FILES.test(file));
  if (arch.length > 0) {
    console.log('pre-commit: check:arch');
    run('pnpm', ['check:arch']);
  }

  console.log('pre-commit: готово');
}

main();
