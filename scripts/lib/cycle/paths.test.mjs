import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  FIXED_NAMES,
  artifactsDir,
  cycleDirName,
  findActiveCycle,
  iterNames,
  repoRoot,
} from './paths.mjs';

/**
 * Временный каталог артефактов, удаляется после теста.
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function makeArtifacts(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hair-lab-artifacts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Создаёт каталог цикла со `state.json`.
 * @param {string} artifacts каталог артефактов
 * @param {string} name имя каталога цикла
 * @param {{ stage?: string }} state
 * @returns {string} путь к каталогу цикла
 */
function makeCycle(artifacts, name, state) {
  const dir = join(artifacts, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, FIXED_NAMES.state), JSON.stringify(state));
  return dir;
}

describe('repoRoot / artifactsDir', () => {
  test('repoRoot совпадает с корнем, который видит git', () => {
    const expected = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();

    assert.equal(repoRoot(), expected);
    assert.ok(existsSync(join(expected, 'AGENTS.md')));
  });

  test('artifactsDir собирается от переданного корня и от корня репозитория', () => {
    assert.equal(artifactsDir('/repo'), join('/repo', '.pi', 'artifacts'));
    assert.equal(artifactsDir(), join(repoRoot(), '.pi', 'artifacts'));
  });
});

describe('cycleDirName', () => {
  const cases = [
    { date: '2026-11-16', issue: 151, slug: 'orchestrator-core-t1a' },
    { date: '2026-01-02', issue: '7', slug: 'fastify-api' },
  ];

  for (const { date, issue, slug } of cases) {
    test(`${date}-${issue}-${slug}`, () => {
      assert.equal(cycleDirName({ date, issue, slug }), `${date}-${issue}-${slug}`);
    });
  }
});

describe('iterNames', () => {
  test('нумерует файлы итерации по единице', () => {
    assert.deepEqual(iterNames(1), {
      plan: 'plan.1.md',
      codeReport: 'code-report.1.md',
      reworkBrief: 'rework-brief.1.md',
      reviewMd: 'review.1.md',
      reviewJson: 'review.1.json',
      evaluationMd: 'evaluation.1.md',
      evaluationJson: 'evaluation.1.json',
      decision: 'decision.1.json',
      gates: 'gates.1.json',
    });
    assert.equal(iterNames(2).reviewJson, 'review.2.json');
  });

  test('отвергает нецелый и нулевой номер', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => iterNames(bad), /целым ≥ 1/);
    }
  });
});

describe('findActiveCycle', () => {
  test('ноль активных циклов — ошибка (DONE, ESCALATED и чужие файлы не считаются)', (t) => {
    const dir = makeArtifacts(t);
    makeCycle(dir, '2026-11-16-150-planning', { stage: 'DONE' });
    makeCycle(dir, '2026-11-16-149-blocked', { stage: 'ESCALATED' });
    // Посторонние сущности в каталоге артефактов: без state.json это не цикл.
    mkdirSync(join(dir, 'queue'));
    mkdirSync(join(dir, '2026-11-16-148-no-state'));
    writeFileSync(join(dir, 'HANDOFF.md'), '# handoff\n');

    assert.throws(() => findActiveCycle(dir), /активный цикл не найден/);
  });

  test('один активный цикл — возвращается его путь', (t) => {
    const dir = makeArtifacts(t);
    makeCycle(dir, '2026-11-15-148-old', { stage: 'DONE' });
    const active = makeCycle(dir, '2026-11-16-151-current', { stage: 'CODE' });
    makeCycle(dir, '2026-11-16-149-escalated', { stage: 'ESCALATED' });

    assert.equal(findActiveCycle(dir), active);
  });

  test('несколько активных циклов — ошибка со списком каталогов', (t) => {
    const dir = makeArtifacts(t);
    makeCycle(dir, '2026-11-16-151-alpha', { stage: 'PLAN' });
    makeCycle(dir, '2026-11-16-152-beta', { stage: 'REVIEW' });

    assert.throws(() => findActiveCycle(dir), /2026-11-16-151-alpha, 2026-11-16-152-beta/);
  });
});
