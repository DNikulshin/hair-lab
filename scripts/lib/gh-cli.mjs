/**
 * Тонкая обёртка над `gh` для проверок состояния задачи в git-хуках и скриптах гигиены.
 *
 * Зачем отдельный модуль: и `scripts/pre-push.mjs`, и `scripts/git-hygiene.mjs` спрашивают
 * GitHub об одном и том же — состоянии PR по ветке. Общая обёртка держит единое поведение
 * при сбоях: нет `gh`, нет сети, нет авторизации — это не повод блокировать git-операцию,
 * поэтому ошибка возвращается как причина, а решает вызывающий код.
 *
 * Shebang не нужен: модуль импортируется из CLI-скриптов.
 */
import { execFileSync } from 'node:child_process';

/** Сколько ждём `gh`: больше — и хук станет заметно медленнее ручного git. */
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Выполняет `gh <args>` и разбирает JSON-ответ.
 * @param {string[]} args аргументы без самого `gh`
 * @param {{ timeoutMs?: number }} [options]
 * @returns {{ ok: true, data: unknown } | { ok: false, reason: string }}
 */
export function ghJson(args, options = {}) {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const stdout = execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    });
    return { ok: true, data: JSON.parse(stdout) };
  } catch (error) {
    return { ok: false, reason: describeGhFailure(error) };
  }
}

/**
 * Человеческая причина сбоя `gh` одной строкой (для предупреждения, не для отказа).
 * @param {unknown} error
 * @returns {string}
 */
export function describeGhFailure(error) {
  if (error !== null && typeof error === 'object') {
    const code = 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return 'gh не установлен';

    const stderr = 'stderr' in error ? String(error.stderr ?? '').trim() : '';
    if (stderr !== '') return stderr.split('\n')[0];

    if ('killed' in error && error.killed === true) return 'gh не ответил вовремя';
    if (error instanceof Error && error.message !== '') return error.message.split('\n')[0];
  }
  return 'gh завершился с ошибкой';
}

/**
 * PR-ы указанной ветки в любом состоянии.
 * @param {string} branch
 * @param {{ timeoutMs?: number }} [options]
 * @returns {{ ok: true, pulls: object[] } | { ok: false, reason: string }}
 */
export function listPullsForBranch(branch, options = {}) {
  const result = ghJson(
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--json',
      'number,state,headRefName,url,mergedAt',
    ],
    options,
  );
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, pulls: Array.isArray(result.data) ? result.data : [] };
}

/**
 * Смерженные PR репозитория (для поиска локальных веток, которые пора удалить).
 * @param {{ limit?: number, timeoutMs?: number }} [options]
 * @returns {{ ok: true, pulls: object[] } | { ok: false, reason: string }}
 */
export function listMergedPulls(options = {}) {
  const result = ghJson(
    [
      'pr',
      'list',
      '--state',
      'merged',
      '--limit',
      String(options.limit ?? 200),
      '--json',
      'number,state,headRefName,mergedAt',
    ],
    options,
  );
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, pulls: Array.isArray(result.data) ? result.data : [] };
}
