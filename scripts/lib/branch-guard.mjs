/**
 * Гейт «ветка уже смержена в PR».
 *
 * Повод: сессия 2026-11-19 начала работу на ветке, чей PR уже был смержен squash'ем
 * (#284, issue #283 закрыт). Squash не делает коммит ветки предком `main`, поэтому
 * `git branch --contains`, `git status` и «ветка запушена» выглядели как незавершённая
 * работа: агент доложил статус догадкой и предложил открыть PR по смерженной задаче.
 * Состояние задачи проверяется фактом (`gh issue view`, `gh pr list --head <ветка>`),
 * а push смерженной ветки отклоняется механизмом — этим модулем.
 *
 * Модуль чистый: данные GitHub и git приходят снаружи, сеть и процессы здесь не вызываются.
 * Shebang не нужен: подключается из `scripts/pre-push.mjs` и `scripts/git-hygiene.mjs`.
 */

/** Состояния pull request, которые приходят из `gh pr list --json state`. */
const MERGED = 'MERGED';

/** SHA удаления ветки: git присылает нули в `pre-push` вместо коммита. */
const ZERO_SHA = /^0+$/;

/**
 * Брался ли ref из `pre-push` в реальный push ветки (не удаление и не тег).
 * @param {{ localRef: string, localSha: string }} ref
 * @returns {boolean}
 */
function isPushedBranch(ref) {
  return (
    typeof ref.localRef === 'string' &&
    ref.localRef.startsWith('refs/heads/') &&
    typeof ref.localSha === 'string' &&
    ref.localSha.length > 0 &&
    !ZERO_SHA.test(ref.localSha)
  );
}

/**
 * Имена веток из stdin `pre-push`, которые git собирается запушить.
 * Удаление (`--delete`) и теги сюда не попадают: у них нет коммита ветки.
 * @param {{ localRef: string, localSha: string }[]} refs
 * @returns {string[]}
 */
export function pushedBranches(refs) {
  if (!Array.isArray(refs)) return [];

  const branches = refs
    .filter(isPushedBranch)
    .map((ref) => ref.localRef.slice('refs/heads/'.length));
  return [...new Set(branches)];
}

/**
 * Смерженный pull request этой ветки или `null`.
 * @param {{ state: string, headRefName?: string }[]} pulls
 * @param {string} branch
 * @returns {{ number?: number, url?: string, mergedAt?: string } | null}
 */
export function mergedPull(pulls, branch) {
  if (!Array.isArray(pulls) || typeof branch !== 'string' || branch === '') return null;

  const head = branch.trim();
  const found = pulls.find(
    (pull) =>
      pull.state === MERGED && (pull.headRefName === undefined || pull.headRefName === head),
  );
  return found ?? null;
}

/**
 * Сообщение об отказе push смерженной ветки или `null`, если push разрешён.
 * @param {string} branch
 * @param {{ number?: number, url?: string }} pull
 * @returns {string|null}
 */
export function mergedBranchBlockReason(branch, pull) {
  const pullInfo = pull === null || typeof pull !== 'object' ? null : pull;
  if (pullInfo === null || typeof branch !== 'string' || branch.trim() === '') return null;

  const label = pullInfo.number === undefined ? 'PR' : `PR #${pullInfo.number}`;
  const name = branch.trim();

  return [
    `pre-push: ветка «${name}» уже смержена (${label}), push запрещён (AGENTS.md).`,
    'Работа влита в main — новая задача начинается с новой ветки:',
    '  git checkout main && git pull && git branch -D ' + name,
    '  git checkout -b chore/<номер-issue>-<краткое-имя>',
    'Список таких веток: pnpm git:hygiene.',
    'Осознанное исключение (правка уже влитого PR): git push --no-verify.',
  ].join('\n');
}

/**
 * Локальные ветки, чьи PR смержены: их пора удалить, иначе работа продолжится на влитом коде.
 * @param {string[]} localBranches ветки из `git for-each-ref refs/heads`
 * @param {{ number?: number, state?: string, headRefName?: string, mergedAt?: string }[]} pulls
 * @returns {{ branch: string, number?: number, mergedAt?: string }[]}
 */
export function staleMergedBranches(localBranches, pulls) {
  if (!Array.isArray(localBranches) || !Array.isArray(pulls)) return [];

  const mergedByHead = new Map();
  for (const pull of pulls) {
    if (pull?.state !== MERGED || typeof pull.headRefName !== 'string') continue;
    if (!mergedByHead.has(pull.headRefName)) mergedByHead.set(pull.headRefName, pull);
  }

  const rows = [];
  for (const branch of [...new Set(localBranches)]) {
    const pull = mergedByHead.get(branch);
    if (pull === undefined) continue;
    rows.push({ branch, number: pull.number, mergedAt: pull.mergedAt });
  }
  return rows;
}
