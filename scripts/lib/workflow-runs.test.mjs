import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { checkShellSyntax } from '../lint-workflows.mjs';
import { extractRunBlocks, isBashShell, replaceExpressions } from './workflow-runs.mjs';

describe('extractRunBlocks: run-блоки workflow (#146)', () => {
  test('блочный скаляр `|`: текст без отступа, строка — первая после `run:`', () => {
    const blocks = extractRunBlocks(
      [
        'name: CI',
        'on: push',
        'jobs:',
        '  checks:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Линт',
        '        run: |',
        '          pnpm lint',
        '          pnpm check:arch',
        '',
      ].join('\n'),
      { file: 'ci.yml' },
    );

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].file, 'ci.yml');
    assert.equal(blocks[0].line, 9);
    assert.equal(blocks[0].job, 'checks');
    assert.equal(blocks[0].step, 'Линт');
    assert.equal(blocks[0].script, 'pnpm lint\npnpm check:arch');
  });

  test('`- run: |` первым ключом шага и инлайн-значение', () => {
    const blocks = extractRunBlocks(
      [
        'jobs:',
        '  docker:',
        '    steps:',
        '      - run: |',
        '          echo start',
        '          echo done',
        '      - run: pnpm typecheck',
        '      - uses: actions/checkout@v4',
        '        run: "echo quoted"',
      ].join('\n'),
    );

    assert.deepEqual(
      blocks.map((block) => block.script),
      ['echo start\necho done', 'pnpm typecheck', 'echo quoted'],
    );
    assert.deepEqual(
      blocks.map((block) => block.line),
      [5, 7, 9],
    );
    assert.equal(blocks[0].step, 'run: |');
    assert.equal(blocks[2].step, 'uses: actions/checkout@v4');
  });

  test('`script:` в github-script — не run-блок', () => {
    const blocks = extractRunBlocks(
      [
        'jobs:',
        '  labels:',
        '    steps:',
        '      - uses: actions/github-script@v7',
        '        with:',
        '          script: |',
        '            const run = "не bash";',
        '            core.info(run);',
      ].join('\n'),
    );

    assert.deepEqual(blocks, []);
  });

  test('свёрнутый блок `>` склеивает строки, пустая строка — перевод', () => {
    const blocks = extractRunBlocks(
      [
        'jobs:',
        '  a:',
        '    steps:',
        '      - run: >-',
        '          echo one',
        '          echo two',
      ].join('\n'),
    );

    assert.equal(blocks[0].script, 'echo one echo two');
  });

  test('выражения `${{ … }}` заменяются на EXPR, включая многострочные', () => {
    assert.equal(
      replaceExpressions('echo "${{ matrix.component }}" >> "$GITHUB_OUTPUT"'),
      'echo "EXPR" >> "$GITHUB_OUTPUT"',
    );
    assert.equal(
      replaceExpressions('if [ "${{ github.event.pull_request.base.ref ||\n  \'main\' }}" ]; then'),
      'if [ "EXPR" ]; then',
    );

    const blocks = extractRunBlocks(
      ['jobs:', '  a:', '    steps:', '      - run: |', '          echo ${{ secrets.TOKEN }}'].join(
        '\n',
      ),
    );
    assert.equal(blocks[0].script, 'echo EXPR');
  });

  test('шаг с чужим `shell:` извлекается, но bash-проверку не проходит', () => {
    const blocks = extractRunBlocks(
      [
        'jobs:',
        '  a:',
        '    steps:',
        '      - name: Скрипт на python',
        '        shell: python',
        '        run: |',
        '          print("hello")',
      ].join('\n'),
    );

    assert.equal(blocks[0].shell, 'python');
    assert.equal(isBashShell(blocks[0].shell), false);
    assert.equal(isBashShell('bash'), true);
    assert.equal(isBashShell('bash {0}'), true);
    assert.equal(isBashShell(null), true);
  });

  test('следующий job переключает подписи', () => {
    const blocks = extractRunBlocks(
      [
        'jobs:',
        '  first:',
        '    steps:',
        '      - name: Раз',
        '        run: echo 1',
        '  second:',
        '    steps:',
        '      - name: Два',
        '        run: echo 2',
      ].join('\n'),
    );

    assert.deepEqual(
      blocks.map((block) => [block.job, block.step]),
      [
        ['first', 'Раз'],
        ['second', 'Два'],
      ],
    );
  });

  test('до `jobs:` run-блоки не ищутся: `on:` и `env:` не путаются', () => {
    const blocks = extractRunBlocks(
      ['on:', '  push:', '    branches: [main]', 'env:', '  RUN: value'].join('\n'),
    );

    assert.deepEqual(blocks, []);
  });
});

describe('checkShellSyntax: bash -n по run-блокам (#146)', () => {
  /** @type {string} */
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hair-lab-lint-workflows-'));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Временный workflow-файл.
   * @param {string} name
   * @param {string} body
   * @returns {string}
   */
  function workflow(name, body) {
    const file = join(dir, name);
    writeFileSync(file, body, 'utf8');
    return file;
  }

  test('корректные run-блоки проходят', () => {
    const file = workflow(
      'good.yml',
      [
        'jobs:',
        '  checks:',
        '    steps:',
        '      - name: Линт',
        '        run: |',
        '          if [ "${{ matrix.component }}" = "api" ]; then',
        '            echo ok',
        '          fi',
      ].join('\n'),
    );

    assert.equal(checkShellSyntax([file]), 0);
  });

  test('незакрытая кавычка — код 1 (репро PR #145)', () => {
    const file = workflow(
      'broken.yml',
      [
        'jobs:',
        '  checks:',
        '    steps:',
        '      - name: Хвост heredoc',
        '        run: |',
        '          echo "начинаем"',
        "          echo 'незакрытая кавычка",
      ].join('\n'),
    );

    assert.equal(checkShellSyntax([file]), 1);
  });

  test('шаг с чужим `shell:` не проверяется bash', () => {
    const file = workflow(
      'python.yml',
      [
        'jobs:',
        '  a:',
        '    steps:',
        '      - name: Питон',
        '        shell: python',
        '        run: |',
        '          print("не закрыто',
      ].join('\n'),
    );

    assert.equal(checkShellSyntax([file]), 0);
  });
});
