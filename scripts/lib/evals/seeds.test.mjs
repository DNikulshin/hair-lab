import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  loadSeeds,
  readSeed,
  seedCriteriaMarkdown,
  seedIssueMarkdown,
  seedOrder,
} from './seeds.mjs';

/** Валидный сид-дефект: используется как база для негативных проверок. */
function defectSeed() {
  return {
    id: 'E5',
    title: 'Телефон в логе',
    why: 'ПДн в логах',
    expect: {
      kind: 'defect',
      severity: 'BLOCKER',
      file: 'apps/api/src/x.ts',
      line: 3,
    },
    issue: { title: 'issue', body: 'тело' },
    criteria: ['критерий'],
    base: { 'apps/api/src/x.ts': 'до\n' },
    after: { 'apps/api/src/x.ts': 'после\n' },
  };
}

describe('readSeed', () => {
  test('принимает корректный сид и сохраняет ожидание', () => {
    const result = readSeed(defectSeed());
    assert.equal(result.ok, true);
    assert.equal(result.seed?.expect.kind, 'defect');
    assert.equal(result.seed?.expect.file, 'apps/api/src/x.ts');
    assert.equal(result.seed?.expect.line, 3);
  });

  test('принимает чистый сид без описания дефекта', () => {
    const seed = defectSeed();
    seed.expect = { kind: 'clean' };
    const result = readSeed(seed);
    assert.equal(result.ok, true);
    assert.deepEqual(result.seed?.expect, { kind: 'clean' });
  });

  test('сид-дефект без severity — ошибка схемы', () => {
    const seed = defectSeed();
    seed.expect = { kind: 'defect', file: 'apps/api/src/x.ts' };
    const result = readSeed(seed);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /expect\.severity/u);
  });

  test('путь с .. отклоняется: сид не должен писать вне дерева прогона', () => {
    const seed = defectSeed();
    seed.after = { '../escape.ts': 'x\n' };
    const result = readSeed(seed);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /недопустимый сегмент пути/u);
  });

  test('абсолютный путь отклоняется', () => {
    const seed = defectSeed();
    seed.base = { '/etc/passwd': 'x\n' };
    const result = readSeed(seed);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /относительный путь/u);
  });

  test('пустой дифф и отсутствие критериев — ошибки', () => {
    const seed = defectSeed();
    seed.after = {};
    seed.criteria = [];
    const result = readSeed(seed);
    assert.equal(result.ok, false);
    const text = result.errors.join('\n');
    assert.match(text, /after: пустой дифф/u);
    assert.match(text, /criteria/u);
  });

  test('нечисловая строка дефекта отклоняется', () => {
    const seed = defectSeed();
    seed.expect.line = 0;
    assert.match(readSeed(seed).errors.join('\n'), /expect\.line/u);
  });

  test('не объект — одна внятная ошибка', () => {
    assert.deepEqual(readSeed(null).errors, ['сид: ожидается объект']);
  });
});

describe('loadSeeds', () => {
  test('читает сиды репозитория по возрастанию номера', () => {
    const seeds = loadSeeds(
      join(import.meta.dirname, '..', '..', '..', 'evals', 'orchestrator', 'seeds'),
    );
    assert.deepEqual(
      seeds.map((seed) => seed.id),
      ['E2', 'E5', 'E6', 'E10'],
    );
    for (const seed of seeds) {
      assert.ok(seed.criteria.length > 0, `${seed.id}: критерии`);
      assert.ok(Object.keys(seed.after).length > 0, `${seed.id}: дифф`);
    }
  });

  test('имя файла обязано совпадать с id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-seeds-'));
    const seed = defectSeed();
    writeFileSync(join(dir, 'E9.json'), JSON.stringify(seed));
    assert.throws(() => loadSeeds(dir), /не совпадает с именем файла/u);
  });

  test('пустой каталог — ошибка: прогонять нечего', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-seeds-'));
    mkdirSync(join(dir, 'sub'), { recursive: true });
    assert.throws(() => loadSeeds(dir), /сидов нет/u);
  });
});

describe('порядок и тексты', () => {
  test('E2 идёт раньше E10: сравнение числовое, а не строковое', () => {
    assert.ok(seedOrder('E2') < seedOrder('E10'));
  });

  test('issue.md и criteria.md содержат исходные данные без искажений', () => {
    const result = readSeed(defectSeed());
    assert.ok(result.seed !== null);
    assert.equal(seedIssueMarkdown(result.seed), '# issue\n\nтело\n');
    assert.equal(seedCriteriaMarkdown(result.seed), '# Критерии приёмки\n\n- C1 критерий\n');
  });
});
