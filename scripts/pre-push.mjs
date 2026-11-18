#!/usr/bin/env node
/**
 * `pre-push`-проверка: запрещает push в защищённые ветки (`main`, `master`).
 *
 * Запускается git-хуком `.githooks/pre-push` (подключается `prepare`-скриптом:
 * `git config core.hooksPath .githooks`). git передаёт список ref не аргументами, а stdin:
 * `<local ref> <local sha> <remote ref> <remote sha>`.
 *
 * Обойти: `git push --no-verify` — только осознанно (AGENTS.md: push в `main` запрещён).
 * Ветки читаются из stdin, поэтому проверка не зависит от текущего HEAD: `git push origin
 * main:<другая>` тоже блокируется по remote-ref.
 *
 * Shebang нужен: файл запускается напрямую из хука.
 */
import { readFileSync } from 'node:fs';

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

const reason = pushBlockReason(parsePushRefs(readStdin()));
if (reason !== null) {
  process.stderr.write(`${reason}\n`);
  process.exitCode = 1;
}
