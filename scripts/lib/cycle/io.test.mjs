import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { extractLastJsonBlock, readJson, tail, writeJsonAtomic } from './io.mjs';

/**
 * Временный каталог, удаляется после теста.
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function makeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hair-lab-io-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Тесты прав файловой системы бессмысленны под root: права игнорируются. */
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('readJson', () => {
  test('читает JSON-файл', (t) => {
    const file = join(makeDir(t), 'state.json');
    writeFileSync(file, JSON.stringify({ stage: 'PLAN', iteration: 1 }));

    assert.deepEqual(readJson(file), { stage: 'PLAN', iteration: 1 });
  });

  test('отсутствие файла — исключение', (t) => {
    const file = join(makeDir(t), 'missing.json');

    assert.throws(() => readJson(file), /ENOENT/);
  });
});

describe('writeJsonAtomic', () => {
  test('пишет JSON и не оставляет временных файлов', (t) => {
    const dir = makeDir(t);
    const file = join(dir, 'state.json');

    writeJsonAtomic(file, { stage: 'PLAN', iteration: 1 });

    assert.deepEqual(readJson(file), { stage: 'PLAN', iteration: 1 });
    assert.deepEqual(readdirSync(dir), ['state.json']);
  });

  test('использует переданный сериализатор', (t) => {
    const dir = makeDir(t);
    const file = join(dir, 'state.json');

    writeJsonAtomic(file, { b: 1, a: 2 }, { serialize: (data) => JSON.stringify(data, null, 2) });

    assert.equal(readFileSync(file, 'utf8'), '{\n  "b": 1,\n  "a": 2\n}');
    assert.deepEqual(readdirSync(dir), ['state.json']);
  });

  test('сбой сериализации не трогает существующий файл', (t) => {
    const dir = makeDir(t);
    const file = join(dir, 'state.json');
    writeJsonAtomic(file, { stage: 'OLD' });

    assert.throws(
      () =>
        writeJsonAtomic(
          file,
          { stage: 'NEW' },
          {
            serialize: () => {
              throw new Error('данные не сериализуются');
            },
          },
        ),
      /данные не сериализуются/,
    );

    assert.deepEqual(readJson(file), { stage: 'OLD' });
    assert.deepEqual(readdirSync(dir), ['state.json']);
  });

  test('сбой rename не оставляет частично записанного файла', (t) => {
    const dir = makeDir(t);
    // Цель — каталог: tmp записывается успешно, а renameSync падает.
    const target = join(dir, 'state.json');
    mkdirSync(target);

    assert.throws(() => writeJsonAtomic(target, { stage: 'PLAN' }));

    assert.equal(statSync(target).isDirectory(), true);
    assert.deepEqual(readdirSync(dir), ['state.json']);
  });

  test(
    'нет прав на запись — файл не меняется, tmp не остаётся',
    { skip: isRoot ? 'root игнорирует права файловой системы' : false },
    (t) => {
      const dir = makeDir(t);
      const file = join(dir, 'state.json');
      writeJsonAtomic(file, { stage: 'OLD' });

      chmodSync(dir, 0o555);
      try {
        assert.throws(
          () => writeJsonAtomic(file, { stage: 'NEW' }),
          (error) => error.code === 'EACCES' || error.code === 'EPERM',
        );
      } finally {
        chmodSync(dir, 0o755);
      }

      assert.deepEqual(readJson(file), { stage: 'OLD' });
      assert.deepEqual(readdirSync(dir), ['state.json']);
    },
  );
});

describe('tail', () => {
  test('берёт последние строки', (t) => {
    const file = join(makeDir(t), 'gate.log');
    writeFileSync(file, 'a\nb\nc\nd\ne\n');

    assert.equal(tail(file, 2), 'd\ne');
  });

  test('просит больше строк, чем есть — возвращает весь файл без хвостового перевода', (t) => {
    const file = join(makeDir(t), 'gate.log');
    writeFileSync(file, 'a\nb\nc\n');

    assert.equal(tail(file, 10), 'a\nb\nc');
  });

  test('ноль строк — пустая строка', (t) => {
    const file = join(makeDir(t), 'gate.log');
    writeFileSync(file, 'a\n');

    assert.equal(tail(file, 0), '');
  });
});

describe('extractLastJsonBlock', () => {
  test('берёт последний блок json', () => {
    const markdown = [
      '# Отчёт',
      '```json',
      '{"verdict":"REWORK"}',
      '```',
      'Пояснение между блоками.',
      '```json',
      '{"verdict":"PROCEED","counts":{"blockers":0}}',
      '```',
    ].join('\n');

    assert.deepEqual(extractLastJsonBlock(markdown), {
      verdict: 'PROCEED',
      counts: { blockers: 0 },
    });
  });

  test('игнорирует блоки без метки json', () => {
    const markdown = ['```json', '{"n":1}', '```', '```bash', 'echo 1', '```'].join('\n');

    assert.deepEqual(extractLastJsonBlock(markdown), { n: 1 });
  });

  test('игнорирует незакрытый блок', () => {
    const markdown = ['```json', '{"n":1}', '```', '```json', '{"n":2}'].join('\n');

    assert.deepEqual(extractLastJsonBlock(markdown), { n: 1 });
  });

  test('нет блока — ошибка', () => {
    assert.throws(
      () => extractLastJsonBlock('Обычный текст без блоков кода.'),
      /нет размеченного блока/,
    );
  });

  test('битый JSON в последнем блоке — ошибка', () => {
    const markdown = ['```json', '{"n":1}', '```', '```json', '{"n": }', '```'].join('\n');

    assert.throws(() => extractLastJsonBlock(markdown), /не разбирается как JSON/);
  });
});
