import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { addedLines, baseSha, changedFiles, diffFromBase, intentToAddUntracked } from './git.mjs';

// Глобальный и системный конфиг git в тестах не нужен: он мог бы включить подпись коммитов,
// hooksPath или другую базовую ветку. Наследуется дочерними процессами модуля.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

/**
 * Запускает git в тестовом репозитории.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Временный git-репозиторий с одним коммитом в `main`.
 * Идентичность фиктивная: настоящие имя и адрес в тестах не нужны (§4, ПДн).
 * @param {import('node:test').TestContext} t
 * @returns {{ dir: string, sha: string }}
 */
function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hair-lab-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: dir, encoding: 'utf8' });
  git(['config', 'user.name', 'Test User'], dir);
  git(['config', 'user.email', 'test@example.invalid'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);

  writeFileSync(join(dir, 'tracked.txt'), 'base\n');
  git(['add', 'tracked.txt'], dir);
  git(['commit', '-m', 'base'], dir);

  return { dir, sha: baseSha({ branch: 'main', cwd: dir }) };
}

/** Образец диффа: добавления в существующий файл и в новый файл. */
const SAMPLE_DIFF = [
  'diff --git a/notes.txt b/notes.txt',
  'index 1111111..2222222 100644',
  '--- a/notes.txt',
  '+++ b/notes.txt',
  '@@ -1,2 +1,3 @@',
  ' first',
  '-removed',
  '+second',
  ' third',
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1 @@',
  '+brand new',
].join('\n');

/** Самый неудобный для построчного фильтра случай: содержимое строки само начинается с `++`. */
const TRICKY_DIFF = [
  'diff --git a/keys.txt b/keys.txt',
  'index 1111111..2222222 100644',
  '--- a/keys.txt',
  '+++ b/keys.txt',
  '@@ -1,2 +1,3 @@',
  ' context',
  '+plain line',
  '+++AKIA1234567890123456',
  '-removed line',
].join('\n');

/** Дифф нового файла: заголовок `+++ b/...` не должен попасть в добавления. */
const NEW_FILE_DIFF = [
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+first',
  '+second',
].join('\n');

/** Дифф без завершающего перевода строки: маркеры `\ No newline at end of file` не содержание. */
const NO_NEWLINE_DIFF = [
  'diff --git a/nonl.txt b/nonl.txt',
  'index 1111111..2222222 100644',
  '--- a/nonl.txt',
  '+++ b/nonl.txt',
  '@@ -1 +1 @@',
  '-old',
  '\\ No newline at end of file',
  '+new',
  '\\ No newline at end of file',
].join('\n');

/** Удаление файла и изменение второго: после ханка заголовки следующего файла не добавления. */
const DELETE_THEN_HUNK_DIFF = [
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  'index 4444444..0000000',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-gone',
  'diff --git a/kept.txt b/kept.txt',
  'index 5555555..6666666 100644',
  '--- a/kept.txt',
  '+++ b/kept.txt',
  '@@ -1 +1 @@',
  '-before',
  '+after',
].join('\n');

describe('git', () => {
  test('без intent-to-add новый файл в диффе не виден, после — виден целиком', (t) => {
    const { dir, sha } = makeRepo(t);
    appendFileSync(join(dir, 'tracked.txt'), 'changed\n');
    writeFileSync(join(dir, 'new.txt'), 'new content\n');

    const before = diffFromBase(sha, { cwd: dir });
    assert.match(before, /tracked\.txt/);
    assert.doesNotMatch(before, /new\.txt/);

    assert.deepEqual(intentToAddUntracked({ cwd: dir }), ['new.txt']);

    const after = diffFromBase(sha, { cwd: dir });
    assert.match(after, /new\.txt/);
    assert.match(after, /\+new content/);
    assert.match(after, /\+changed/);
  });

  test('без untracked-файлов intentToAddUntracked ничего не делает', (t) => {
    const { dir } = makeRepo(t);
    appendFileSync(join(dir, 'tracked.txt'), 'changed\n');

    assert.deepEqual(intentToAddUntracked({ cwd: dir }), []);
  });

  test('changedFiles перечисляет изменённые файлы от базы', (t) => {
    const { dir, sha } = makeRepo(t);
    appendFileSync(join(dir, 'tracked.txt'), 'changed\n');
    writeFileSync(join(dir, 'new.txt'), 'new content\n');
    intentToAddUntracked({ cwd: dir });

    assert.deepEqual(changedFiles(sha, { cwd: dir }), ['new.txt', 'tracked.txt']);
  });

  test('baseSha возвращает sha коммита базовой ветки', (t) => {
    const { dir, sha } = makeRepo(t);

    assert.match(sha, /^[0-9a-f]{40}$/);
    assert.equal(sha, git(['rev-parse', 'HEAD'], dir).trim());
  });

  test('addedLines оставляет только добавленные строки без префикса', () => {
    assert.deepEqual(addedLines(SAMPLE_DIFF), ['second', 'brand new']);
  });

  test('addedLines не путает добавленную строку, начинающуюся с `++`, с заголовком', () => {
    assert.deepEqual(addedLines(TRICKY_DIFF), ['plain line', '++AKIA1234567890123456']);
    assert.ok(addedLines(TRICKY_DIFF).every((line) => !line.startsWith('++ b/')));
  });

  test('addedLines читает дифф нового файла и не возвращает заголовок `+++ b/...`', () => {
    assert.deepEqual(addedLines(NEW_FILE_DIFF), ['first', 'second']);
  });

  test('addedLines игнорирует маркеры `\\ No newline at end of file`', () => {
    assert.deepEqual(addedLines(NO_NEWLINE_DIFF), ['new']);
  });

  test('addedLines пропускает удаления и заголовки следующего файла', () => {
    assert.deepEqual(addedLines(DELETE_THEN_HUNK_DIFF), ['after']);
  });

  test('diffFromBase отклоняет небезопасную базу и не даёт git принять её за опцию', (t) => {
    const { dir } = makeRepo(t);
    const victim = join(dir, 'victim.txt');
    const unsafe = [
      '--output=/tmp/x',
      `--output=${victim}`,
      '-x',
      'main main',
      'main\nx',
      'main\t..',
      '../main',
      'main..x',
      'main//x',
      '/main',
      'main/',
      '.git',
      '',
    ];

    for (const base of unsafe) {
      assert.throws(
        () => diffFromBase(base, { cwd: dir }),
        /base:/,
        `база должна отклоняться: ${base}`,
      );
      assert.throws(
        () => changedFiles(base, { cwd: dir }),
        /base:/,
        `база должна отклоняться: ${base}`,
      );
    }
    assert.throws(() => baseSha({ branch: '--upload-pack=touch /tmp/x', cwd: dir }), /branch:/);
    assert.throws(() => baseSha({ branch: '-x', cwd: dir }), /branch:/);

    assert.equal(existsSync(victim), false, 'файл из --output не должен создаваться');
    assert.equal(existsSync('/tmp/x'), false, 'файл из --output=/tmp/x не должен создаваться');
  });

  test('diffFromBase отклоняет опции git без явного cwd (значение проверяется до вызова)', () => {
    assert.throws(() => diffFromBase('--output=/tmp/x'), /base:/);
    assert.throws(() => diffFromBase('-x'), /base:/);
    assert.throws(() => diffFromBase('main main'), /base:/);
    assert.throws(() => diffFromBase('main\nx'), /base:/);
    assert.equal(existsSync('/tmp/x'), false, 'файл из --output=/tmp/x не должен создаваться');
  });

  test('безопасные базы: sha и имя ссылки работают', (t) => {
    const { dir, sha } = makeRepo(t);
    appendFileSync(join(dir, 'tracked.txt'), 'changed\n');

    assert.equal(diffFromBase(sha, { cwd: dir }), diffFromBase('main', { cwd: dir }));
    assert.deepEqual(changedFiles('main', { cwd: dir }), ['tracked.txt']);
    assert.equal(baseSha({ branch: 'main', cwd: dir }), sha);
  });
});
