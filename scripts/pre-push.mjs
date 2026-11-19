#!/usr/bin/env node
/**
 * `pre-push`-проверки: запрет push в защищённые ветки (`main`, `master`) и запрет push
 * ветки, чей PR уже смержен.
 *
 * Запускается git-хуком `.githooks/pre-push` (подключается `prepare`-скриптом:
 * `git config core.hooksPath .githooks`). git передаёт список ref не аргументами, а stdin:
 * `<local ref> <local sha> <remote ref> <remote sha>`.
 *
 * Повод для второй проверки (issue #285): squash-merge не делает коммит ветки предком `main`,
 * поэтому после мержа PR git показывает ветку как «не влитую». Сессия 2026-11-19 продолжила
 * работу на такой ветке и доложила статус догадкой. Теперь push такой ветки останавливается
 * с командой очистки, а состояние задачи проверяется фактом (`gh pr list --head <ветка>`).
 *
 * GitHub недоступен (`gh` не установлен, нет сети или авторизации) — только предупреждение:
 * проверка защищённых веток работает офлайн и остаётся единственным жёстким гейтом.
 *
 * Обойти: `git push --no-verify` — только осознанно (AGENTS.md: push в `main` запрещён).
 * Ветки читаются из stdin, поэтому проверка не зависит от текущего HEAD: `git push origin
 * main:<другая>` тоже блокируется по remote-ref.
 *
 * Shebang нужен: файл запускается напрямую из хука.
 */
import { readFileSync } from 'node:fs';

import { mergedBranchBlockReason, mergedPull, pushedBranches } from './lib/branch-guard.mjs';
import { listPullsForBranch } from './lib/gh-cli.mjs';
import { pushBlockReason, parsePushRefs } from './lib/git-guard.mjs';

/**
 * Читает stdin целиком (git закрывает поток после списка ref).
 * @returns {string}
 */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Причины отказа по смерженным веткам: пусто, если PR открыт, не создан или GitHub не ответил.
 * @param {string[]} branches
 * @returns {string[]}
 */
function mergedBranchReasons(branches) {
  /** @type {string[]} */
  const reasons = [];

  for (const branch of branches) {
    const lookup = listPullsForBranch(branch);
    if (!lookup.ok) {
      process.stderr.write(
        `pre-push: состояние PR для «${branch}» не проверено (${lookup.reason}) — проверьте gh pr list --head ${branch}\n`,
      );
      continue;
    }

    const pull = mergedPull(lookup.pulls, branch);
    if (pull === null) continue;
    reasons.push(mergedBranchBlockReason(branch, pull));
  }

  return reasons;
}

const refs = parsePushRefs(readStdin());
const reasons = [pushBlockReason(refs), ...mergedBranchReasons(pushedBranches(refs))].filter(
  (reason) => reason !== null,
);

if (reasons.length > 0) {
  for (const reason of reasons) process.stderr.write(`${reason}\n`);
  process.exitCode = 1;
}
