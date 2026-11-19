/**
 * Защита от коммитов и push в защищённые ветки.
 *
 * Повод: коммит на `main` по ошибке (задача #250, 2026-11-18) — правила AGENTS.md требуют
 * работать в ветке `fix/*|feat/*|chore/*|data/*|design/*` и мержить только через PR.
 * Механизм, а не напоминание: проверка живёт в хуках (`pre-commit`, `pre-push`), потому что
 * забыть про неё нельзя, а `--no-verify` — осознанное действие.
 *
 * Модуль чистый: имена ветвей и строки `pre-push` приходят снаружи, git здесь не вызывается.
 * Shebang не нужен: модуль подключается из `scripts/precommit.mjs` и `scripts/pre-push.mjs`.
 */

/** Ветки, в которые нельзя коммитить и пушить напрямую. */
export const PROTECTED_BRANCHES = Object.freeze(['main', 'master']);

/** Отсоединённый HEAD: `git rev-parse --abbrev-ref HEAD` отдаёт такое имя. */
const DETACHED = 'HEAD';

/**
 * Защищённая ли ветка (имя как у `git rev-parse --abbrev-ref HEAD`).
 * @param {string} branch
 * @returns {boolean}
 */
export function isProtectedBranch(branch) {
  if (typeof branch !== 'string') return false;
  return PROTECTED_BRANCHES.includes(branch.trim());
}

/**
 * Сообщение об отказе коммита или `null`, если коммит разрешён.
 * @param {string} branch текущая ветка
 * @returns {string|null}
 */
export function commitBlockReason(branch) {
  if (!isProtectedBranch(branch)) return null;
  return [
    `pre-commit: коммит в защищённую ветку «${branch.trim()}» запрещён (AGENTS.md).`,
    'Создайте ветку по задаче и повторите:',
    '  git checkout -b fix/<номер>-<краткое-имя>',
    '  git commit …',
    'Осознанное исключение (bootstrap пустого репозитория): git commit --no-verify.',
  ].join('\n');
}

/**
 * Разбирает stdin `pre-push` (по строке на ref): `<local ref> <local sha> <remote ref> <remote sha>`.
 * SHA нужен гейту смерженных веток (`scripts/lib/branch-guard.mjs`): у удаления ветки он нулевой.
 * @param {string} text
 * @returns {{ localRef: string, localSha: string, remoteRef: string }[]}
 */
export function parsePushRefs(text) {
  if (typeof text !== 'string') return [];
  /** @type {{ localRef: string, localSha: string, remoteRef: string }[]} */
  const refs = [];

  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    // Строки без четырёх полей — мусор в stdin: пропускаем, а не падаем на push.
    if (fields.length < 4) continue;
    refs.push({ localRef: fields[0], localSha: fields[1], remoteRef: fields[2] });
  }
  return refs;
}

/**
 * Сообщение об отказе push или `null`, если push разрешён. Удаление ветки
 * (`git push origin --delete main`) сюда же: удалять защищённую ветку тоже нельзя.
 * @param {{ localRef: string, remoteRef: string }[]} refs
 * @returns {string|null}
 */
export function pushBlockReason(refs) {
  const blocked = refs
    .filter((ref) => ref.remoteRef.startsWith('refs/heads/'))
    .map((ref) => ref.remoteRef.slice('refs/heads/'.length));

  const offenders = [...new Set(blocked.filter(isProtectedBranch))];
  if (offenders.length === 0) return null;

  return [
    `pre-push: push в защищённую ветку «${offenders.join('», «')}» запрещён (AGENTS.md).`,
    'Пушьте рабочую ветку и открывайте PR:',
    '  git push -u origin <ваша-ветка>',
    'Осознанное исключение (bootstrap пустого репозитория): git push --no-verify.',
  ].join('\n');
}

/**
 * Имя текущей ветки глазами git: отсоединённый HEAD — не защищённая ветка, но и не
 * повод блокировать коммит в detached-состоянии (это отдельный риск, не этот гейт).
 * @param {string} branch вывод `git rev-parse --abbrev-ref HEAD`
 * @returns {string}
 */
export function normalizeBranch(branch) {
  if (typeof branch !== 'string') return '';
  const trimmed = branch.trim();
  return trimmed === DETACHED ? '' : trimmed;
}
