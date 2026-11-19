#!/usr/bin/env node
/**
 * Гигиена локальных веток: показывает ветки, чьи PR уже смержены, и (по `--prune`) удаляет их.
 *
 * Зачем: squash-merge не оставляет коммит ветки предком `main`, поэтому после мержа PR
 * локальная ветка выглядит «не влитой» — легко продолжить на ней работу и доложить статус
 * по уже закрытой задаче (issue #285, 2026-11-19). Команда запускается в начале сессии,
 * состояние задачи берётся из GitHub фактом, а не из памяти.
 *
 * Запуск: `pnpm git:hygiene` (только отчёт), `pnpm git:hygiene --prune` (удалить смерженные,
 * кроме текущей ветки). GitHub недоступен — отчёт не строится, печатается причина и код 0:
 * гигиена не должна ломать работу.
 *
 * Shebang нужен: файл запускается напрямую (`node scripts/git-hygiene.mjs`).
 */
import { execFileSync } from 'node:child_process';

import { staleMergedBranches } from './lib/branch-guard.mjs';
import { listMergedPulls } from './lib/gh-cli.mjs';

/** @param {string[]} args */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Локальные ветки репозитория.
 * @returns {string[]}
 */
function localBranches() {
  const output = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return output === ''
    ? []
    : output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

/**
 * Форматирует дату мержа для отчёта.
 * @param {string|undefined} mergedAt
 * @returns {string}
 */
function formatMergedAt(mergedAt) {
  if (typeof mergedAt !== 'string' || mergedAt === '') return '—';
  return mergedAt.slice(0, 10);
}

/**
 * Печатает отчёт и, если просили, удаляет смерженные ветки.
 * @param {boolean} prune
 * @returns {number} код возврата
 */
function main(prune) {
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD']);

  const merged = listMergedPulls();
  if (!merged.ok) {
    console.warn(
      `git-hygiene: состояние PR не проверено (${merged.reason}) — проверьте вручную: gh pr list --state merged`,
    );
    return 0;
  }

  const stale = staleMergedBranches(localBranches(), merged.pulls);
  if (stale.length === 0) {
    console.log('git-hygiene: смерженных локальных веток нет');
  } else {
    console.log(`git-hygiene: ветки с смерженными PR (${stale.length}):`);
    for (const row of stale) {
      const label = row.number === undefined ? 'PR' : `PR #${row.number}`;
      const self = row.branch === current ? '  ← текущая ветка' : '';
      console.log(`  ${row.branch}  ${label}, ${formatMergedAt(row.mergedAt)}${self}`);
    }
  }

  if (current !== 'main' && current !== 'master' && !stale.some((row) => row.branch === current)) {
    console.log(`git-hygiene: текущая ветка «${current}» смерженным PR не помечена`);
  }

  if (!prune) {
    if (stale.length > 0) {
      console.log('Удалить: pnpm git:hygiene --prune (текущая ветка не удаляется)');
    }
    return 0;
  }

  let removed = 0;
  for (const row of stale) {
    if (row.branch === current) {
      console.warn(`git-hygiene: «${row.branch}» — текущая ветка, пропущена`);
      continue;
    }
    try {
      git(['branch', '-D', row.branch]);
      console.log(`git-hygiene: удалена «${row.branch}»`);
      removed += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      console.warn(`git-hygiene: «${row.branch}» не удалена (${reason})`);
    }
  }

  console.log(`git-hygiene: удалено веток — ${removed}`);
  return 0;
}

process.exitCode = main(process.argv.includes('--prune'));
