/**
 * Git-операции ядра цикла (docs/orchestrator-core.md §5.2).
 *
 * Все вызовы — `execFileSync('git', [...])` без оболочки: аргументы не интерполируются,
 * имена файлов с пробелами и спецсимволами безопасны. Сеть не используется.
 * Shebang не нужен: модуль подключается из CLI-скриптов `cycle-*.mjs`.
 */
import { execFileSync } from 'node:child_process';

import { repoRoot } from './paths.mjs';

/**
 * Запускает git и возвращает stdout.
 * @param {string[]} args
 * @param {string} cwd рабочий каталог (обычно корень репозитория)
 * @returns {string}
 */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Разрешённые символы значения базы: sha или имя ссылки без спецсимволов git. */
const SAFE_REV_CHARS = /^[A-Za-z0-9._/-]+$/;

/** Ссылка не начинается с точки: `.git`, `.lock` и подобное — не базы диффа. */
const SAFE_REV_START = /^[A-Za-z0-9]/;

/**
 * Проверяет, что значение — sha или имя ссылки, и git не сможет принять его за опцию.
 * База приходит из конфига и веток цикла, но `--output=/tmp/x`, `-x` или `main main`
 * в argv git становятся опциями/лишними аргументами, поэтому значение валидируется
 * до вызова: только `[A-Za-z0-9._/-]`, без `..`, `//`, ведущих/завершающих `./` и `.lock`.
 * @param {unknown} rev sha (40 hex) или имя ссылки (`main`, `origin/main`)
 * @param {string} label имя параметра для сообщения об ошибке
 * @returns {string} проверенное значение
 */
function assertSafeRev(rev, label) {
  if (typeof rev !== 'string' || rev === '') {
    throw new Error(`${label}: ожидается sha или имя ссылки, получено ${JSON.stringify(rev)}`);
  }
  if (rev.startsWith('-')) {
    throw new Error(`${label}: значение не может начинаться с "-": ${rev}`);
  }
  if (!SAFE_REV_CHARS.test(rev) || !SAFE_REV_START.test(rev)) {
    throw new Error(
      `${label}: недопустимые символы (разрешены A-Za-z0-9._/-): ${JSON.stringify(rev)}`,
    );
  }
  const badForm =
    rev.includes('..') ||
    rev.includes('//') ||
    rev.endsWith('/') ||
    rev.endsWith('.') ||
    rev.endsWith('.lock');
  if (badForm) {
    throw new Error(`${label}: недопустимая форма ссылки: ${rev}`);
  }
  return rev;
}

/**
 * Sha базовой ветки: от него считается дифф цикла.
 * @param {{ branch?: string, cwd?: string }} [options]
 * @returns {string}
 */
export function baseSha({ branch = 'main', cwd = repoRoot() } = {}) {
  const safe = assertSafeRev(branch, 'branch');
  return git(['rev-parse', '--verify', '--end-of-options', safe], cwd).trim();
}

/**
 * Делает untracked-файлы видимыми в `git diff` через `--intent-to-add`.
 * Это единственное разрешённое вмешательство в индекс (§4): содержимое файлов не меняется,
 * новые файлы видны при этом только в диффе от базы, но не в HEAD.
 * Пустой результат — штатный no-op.
 * @param {{ cwd?: string }} [options]
 * @returns {string[]} файлы, добавленные в индекс как intent-to-add
 */
export function intentToAddUntracked({ cwd = repoRoot() } = {}) {
  const untracked = git(['ls-files', '-z', '--others', '--exclude-standard'], cwd)
    .split('\0')
    .filter((file) => file !== '');

  if (untracked.length === 0) return [];

  git(['add', '--intent-to-add', '--', ...untracked], cwd);
  return untracked;
}

/**
 * Дифф рабочего дерева от базы (включая staged-изменения и intent-to-add).
 * @param {string} base sha или имя ветки
 * @param {{ cwd?: string }} [options]
 * @returns {string}
 */
export function diffFromBase(base, { cwd = repoRoot() } = {}) {
  const safe = assertSafeRev(base, 'base');
  return git(['diff', '--no-color', safe, '--'], cwd);
}

/**
 * Изменённые файлы от базы. Переименования не разворачиваются: старый и новый путь
 * считаются обычными изменениями (диффы короче, условия гейтов проще).
 * @param {string} base sha или имя ветки
 * @param {{ cwd?: string }} [options]
 * @returns {string[]}
 */
export function changedFiles(base, { cwd = repoRoot() } = {}) {
  const safe = assertSafeRev(base, 'base');
  return git(['diff', '--name-only', '--no-renames', safe, '--'], cwd)
    .split('\n')
    .filter((file) => file !== '');
}

/**
 * Добавленные строки диффа без префикса `+` — вход для `scanSecrets`.
 * Разбор структурный, а не по префиксам: заголовок файла (`diff --git`, `index`, `---`,
 * `+++`, `new file mode`, `deleted file mode`, `similarity index`, `rename from/to`,
 * `Binary files`) встречается только вне ханков, ханк начинается с `@@`. Внутри ханка
 * добавлены строки с `+` (их содержимое может само начинаться с `++`), контекст, удаления
 * и маркеры `\ No newline at end of file` пропускаются. Поэтому заголовки `+++ b/...`
 * в результат не попадают.
 * @param {string} diff вывод `git diff`
 * @returns {string[]}
 */
export function addedLines(diff) {
  /** @type {string[]} */
  const added = [];
  let inHunk = false;

  for (const line of diff.split('\n')) {
    // Новый файл закрывает предыдущий ханк: иначе `+++ b/next` попал бы в добавления.
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (inHunk && line.startsWith('+')) {
      added.push(line.slice(1));
    }
  }

  return added;
}
