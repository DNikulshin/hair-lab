import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  commitBlockReason,
  isProtectedBranch,
  normalizeBranch,
  parsePushRefs,
  pushBlockReason,
} from './lib/git-guard.mjs';

/** Корень репозитория: CLI проверок запускаются с ним в cwd. */
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PRE_PUSH = fileURLToPath(new URL('./pre-push.mjs', import.meta.url));
const PRECOMMIT = fileURLToPath(new URL('./precommit.mjs', import.meta.url));

/** Имя ветки, куда коммитить можно: под ним идёт работа по задачам. */
const FEATURE_BRANCH = 'fix/250-migrations-clean-gate';

/**
 * Временный git-репозиторий с указанной текущей веткой и одним закоммиченным файлом.
 * @param {string} branch
 * @returns {string}
 */
function makeRepo(branch) {
  const dir = mkdtempSync(join(tmpdir(), 'hair-lab-guard-'));
  /** @param {string[]} args */
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

  git(['-c', 'init.defaultBranch=main', 'init']);
  git(['config', 'user.name', 'Test User']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'tracked.txt'), 'base\n');
  git(['add', 'tracked.txt']);
  git(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'base']);
  if (branch !== 'main') git(['checkout', '-b', branch]);

  return dir;
}

describe('git-guard: защищённые ветки', () => {
  test('main и master защищены, рабочие ветки — нет', () => {
    assert.equal(isProtectedBranch('main'), true);
    assert.equal(isProtectedBranch('main\n'), true);
    assert.equal(isProtectedBranch('master'), true);
    assert.equal(isProtectedBranch(FEATURE_BRANCH), false);
    assert.equal(isProtectedBranch('main-hotfix'), false);
    assert.equal(isProtectedBranch(''), false);
    assert.equal(isProtectedBranch(null), false);
  });

  test('отказ коммита называет правило, команду создания ветки и обход', () => {
    const reason = commitBlockReason('main');

    assert.ok(reason !== null);
    assert.match(reason, /защищённую ветку «main»/);
    assert.match(reason, /git checkout -b fix\/<номер>-<краткое-имя>/);
    assert.match(reason, /--no-verify/);
  });

  test('рабочая ветка не блокируется', () => {
    assert.equal(commitBlockReason(FEATURE_BRANCH), null);
  });

  test('отсоединённый HEAD не считается защищённой веткой', () => {
    assert.equal(normalizeBranch('HEAD'), '');
    assert.equal(commitBlockReason(normalizeBranch('HEAD')), null);
    assert.equal(normalizeBranch(' main '), 'main');
  });
});

describe('git-guard: pre-push', () => {
  test('строки stdin разбираются на local/remote ref', () => {
    const refs = parsePushRefs(
      [
        'refs/heads/fix/250-gate abc123 refs/heads/fix/250-gate def456',
        'refs/heads/main def456 refs/heads/main 000',
        '',
        'мусор',
      ].join('\n'),
    );

    assert.deepEqual(refs, [
      { localRef: 'refs/heads/fix/250-gate', remoteRef: 'refs/heads/fix/250-gate' },
      { localRef: 'refs/heads/main', remoteRef: 'refs/heads/main' },
    ]);
  });

  test('push в рабочую ветку разрешён, в main — запрещён', () => {
    assert.equal(pushBlockReason(parsePushRefs('refs/heads/fix/1 abc refs/heads/fix/1 def')), null);

    const reason = pushBlockReason(parsePushRefs('local abc refs/heads/main def'));
    assert.ok(reason !== null);
    assert.match(reason, /push в защищённую ветку «main»/);
    assert.match(reason, /--no-verify/);
  });

  test('push локальной ветки в чужой remote-ref main блокируется', () => {
    const reason = pushBlockReason(
      parsePushRefs(`refs/heads/${FEATURE_BRANCH} abc refs/heads/main def`),
    );

    assert.match(String(reason), /«main»/);
  });

  test('удаление main и master блокируется, теги — нет', () => {
    const deleted = 'refs/heads/main 0000 refs/heads/main abc';
    assert.match(String(pushBlockReason(parsePushRefs(deleted))), /«main»/);

    const tags = 'refs/tags/v1.0.0 abc refs/tags/v1.0.0 def';
    assert.equal(pushBlockReason(parsePushRefs(tags)), null);
  });

  test('пустой stdin и мусор не блокируют push', () => {
    assert.equal(pushBlockReason(parsePushRefs('')), null);
    assert.equal(pushBlockReason(parsePushRefs('не ref')), null);
    assert.equal(pushBlockReason([]), null);
  });
});

describe('git-guard: хуки в реальном репозитории', () => {
  test('pre-push-скрипт: код 1 и сообщение при push в main', () => {
    const result = spawnSync(process.execPath, [PRE_PUSH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: 'refs/heads/x 111 refs/heads/main 222\n',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /защищённую ветку «main»/);
  });

  test('pre-push-скрипт: код 0 при push в рабочую ветку', () => {
    const result = spawnSync(process.execPath, [PRE_PUSH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: `refs/heads/${FEATURE_BRANCH} 111 refs/heads/${FEATURE_BRANCH} 222\n`,
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });

  test('pre-commit: на main отклоняет коммит до запуска prettier', (t) => {
    const repo = makeRepo('main');
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    writeFileSync(join(repo, 'tracked.txt'), 'change\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });

    const result = spawnSync(process.execPath, [PRECOMMIT], { cwd: repo, encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /защищённую ветку «main»/);
    assert.equal(result.stdout.includes('pre-commit: prettier'), false);
  });

  test('pre-commit: в рабочей ветке проверка ветки не мешает (нет зависимостей — пропуск)', (t) => {
    const repo = makeRepo(FEATURE_BRANCH);
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    writeFileSync(join(repo, 'tracked.txt'), 'change\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });

    const result = spawnSync(process.execPath, [PRECOMMIT], { cwd: repo, encoding: 'utf8' });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /зависимости не установлены/);
  });
});
