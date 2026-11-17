import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  aggregateGates,
  buildReport,
  listCycleDirs,
  median,
  parseArgs,
  percent,
  renderMarkdown,
  summarizeCycle,
} from './cycle-report.mjs';

/** Путь к CLI: сквозные тесты запускают его отдельным процессом. */
const SCRIPT = fileURLToPath(new URL('./cycle-report.mjs', import.meta.url));

/** Корень фикстур метрик: `scripts/fixtures/cycle/metrics/`. */
const METRICS_FIXTURES = fileURLToPath(new URL('./fixtures/cycle/metrics/', import.meta.url));

/** Валидный `metrics.json` фикстуры: база для вариантов в тестах. */
function metricsDoc(overrides = {}) {
  const base = JSON.parse(readFileSync(join(METRICS_FIXTURES, 'metrics.valid.json'), 'utf8'));
  return { ...base, ...overrides };
}

/**
 * Временный каталог артефактов.
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function makeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hair-lab-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Кладёт `metrics.json` в подкаталог цикла.
 * @param {string} dir каталог артефактов
 * @param {string} name имя цикла
 * @param {Record<string, any>} doc
 * @returns {string} путь к каталогу цикла
 */
function writeCycle(dir, name, doc) {
  const cycleDir = join(dir, name);
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'metrics.json'), `${JSON.stringify(doc, null, 2)}\n`);
  return cycleDir;
}

/**
 * Запускает CLI как отдельный процесс.
 * @param {string[]} args
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('cycle-report: median и percent', () => {
  test('медиана нечётного и чётного списка, пустой — null', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([4.72, 21.36]), 13.04);
    assert.equal(median([]), null);
    assert.equal(median(null), null);
  });

  test('percent: делить не на что — null, иначе одна цифра после запятой', () => {
    assert.equal(percent(1, 4), 25);
    assert.equal(percent(1, 3), 33.3);
    assert.equal(percent(0, 0), null);
  });
});

describe('cycle-report: сводка по метрикам', () => {
  test('summarizeCycle берёт факты и не выдумывает отсутствующие поля', () => {
    const summary = summarizeCycle(
      '2026-11-17-108-confirmation-url',
      metricsDoc({ cost_rub: 4.72 }),
    );

    assert.equal(summary.name, '2026-11-17-108-confirmation-url');
    assert.equal(summary.final_stage, 'DONE');
    assert.equal(summary.iterations, 2);
    assert.equal(summary.cost_rub, 4.72);
    assert.deepEqual(summary.findings, { only_review: 4, only_evaluator: 2, both: 2 });
    assert.deepEqual(summary.evaluator_defects, { BLOCKER: 1, MAJOR: 2, MINOR: 1 });

    const sparse = summarizeCycle('x', {
      final_stage: 'ESCALATED',
      iterations: 1,
      max_iterations: 2,
    });
    assert.equal(sparse.cost_rub, null, 'нет замера — null, а не ноль');
    assert.equal(sparse.duration_s, undefined);
    assert.deepEqual(sparse.findings, { only_review: 0, only_evaluator: 0, both: 0 });
    assert.deepEqual(sparse.evaluator_defects, { BLOCKER: 0, MAJOR: 0, MINOR: 0 });
    assert.equal(sparse.unresolved_refs, 0);
  });

  test('buildReport: сумма и медиана — только по циклам с расходом', () => {
    const cycles = [
      summarizeCycle(
        'a',
        metricsDoc({ cost_rub: 4.72, only_review: 0, only_evaluator: 3, both: 0 }),
      ),
      summarizeCycle(
        'b',
        metricsDoc({ cost_rub: 21.36, only_review: 1, only_evaluator: 0, both: 1 }),
      ),
      summarizeCycle(
        'c',
        metricsDoc({ cost_rub: null, only_review: 0, only_evaluator: 0, both: 0 }),
      ),
    ];

    const report = buildReport(cycles, { skipped: 5 });

    assert.deepEqual(report.cost, { measured: 2, total: 3, sum: 26.08, median: 13.04 });
    assert.deepEqual(report.findings, { evaluator_only: 3, total: 5, percent: 60 });
    assert.equal(report.skipped, 5);
  });

  test('buildReport без расходов: сумма и медиана — null, а не 0', () => {
    const report = buildReport([
      summarizeCycle(
        'a',
        metricsDoc({ cost_rub: null, only_review: 0, only_evaluator: 0, both: 0 }),
      ),
    ]);

    assert.deepEqual(report.cost, { measured: 0, total: 1, sum: null, median: null });
    assert.deepEqual(report.findings, { evaluator_only: 0, total: 0, percent: null });
  });

  test('aggregateGates суммирует исходы, порядок — таблица §5.5, затем алфавит', () => {
    const cycles = [
      summarizeCycle(
        'a',
        metricsDoc({ gate_outcomes: { zz_custom: { pass: 1 }, lint: { fail: 2 } } }),
      ),
      summarizeCycle(
        'b',
        metricsDoc({ gate_outcomes: { lint: { pass: 1 }, aa_custom: { not_run: 3 } } }),
      ),
    ];

    assert.deepEqual(aggregateGates(cycles), [
      { id: 'lint', pass: 1, fail: 2, skipped: 0, not_run: 0 },
      { id: 'aa_custom', pass: 0, fail: 0, skipped: 0, not_run: 3 },
      { id: 'zz_custom', pass: 1, fail: 0, skipped: 0, not_run: 0 },
    ]);
  });
});

describe('cycle-report: markdown', () => {
  test('шапка с итогами, строка на цикл и таблица гейтов', () => {
    const report = buildReport([
      summarizeCycle('2026-11-17-108-confirmation-url', metricsDoc({ cost_rub: 4.72 })),
    ]);
    const text = renderMarkdown(report);

    assert.match(text, /^# Отчёт по циклам\n/u);
    assert.ok(text.includes('Циклов: 1, с расходом: 1. Расход: 4.72 ₽, медиана: 4.72 ₽.'));
    assert.ok(text.includes('| 2026-11-17-108-confirmation-url | DONE | 2/2 |'));
    assert.ok(text.includes('| contracts_build | 2 | 0 | 0 | 0 |'));
    assert.ok(text.endsWith('\n'), 'вывод завершается переводом строки');
  });

  test('нет циклов — честное сообщение, а не пустая таблица', () => {
    const text = renderMarkdown(buildReport([], { skipped: 7 }));

    assert.ok(text.includes('Циклов с `metrics.json` нет'));
    assert.ok(text.includes('Пропущено каталогов без `metrics.json`: 7.'));
    assert.ok(!text.includes('| Цикл |'));
  });
});

describe('cycle-report: CLI', () => {
  test('читает metrics.json каталогов и печатает отчёт детерминированно', (t) => {
    const dir = makeDir(t);
    writeCycle(
      dir,
      '2026-11-16-188-health-db',
      metricsDoc({ cost_rub: null, final_stage: 'ESCALATED' }),
    );
    writeCycle(dir, '2026-11-17-108-confirmation-url', metricsDoc({ cost_rub: 4.72 }));
    mkdirSync(join(dir, 'no-metrics'), { recursive: true });
    mkdirSync(join(dir, 'evals'), { recursive: true });

    const first = runCli(['--dir', dir]);
    const second = runCli(['--dir', dir]);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, second.stdout, 'два прогона дают побайтно равный отчёт');
    assert.ok(first.stdout.includes('Циклов: 2, с расходом: 1.'));
    assert.ok(first.stdout.includes('Пропущено каталогов без `metrics.json`: 2.'));
    assert.ok(
      first.stdout.indexOf('2026-11-16-188-health-db') <
        first.stdout.indexOf('2026-11-17-108-confirmation-url'),
      'каталоги идут по имени',
    );
  });

  test('--json отдаёт тот же отчёт структурой', (t) => {
    const dir = makeDir(t);
    writeCycle(dir, 'a', metricsDoc({ cost_rub: 4.72 }));

    const result = runCli(['--dir', dir, '--json']);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.cycles.length, 1);
    assert.deepEqual(report.cost, { measured: 1, total: 1, sum: 4.72, median: 4.72 });
    assert.ok(Array.isArray(report.gates));
  });

  test('битый metrics.json — код 2 с именем каталога, а не молчаливый пропуск', (t) => {
    const dir = makeDir(t);
    const cycleDir = writeCycle(dir, 'broken', metricsDoc());
    writeFileSync(join(cycleDir, 'metrics.json'), '{"iterations": \n');

    const result = runCli(['--dir', dir]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /^cycle-report: broken\/metrics\.json: не читается/u);
    assert.equal(result.stdout, '');
  });

  test('metrics.json с нарушенной схемой — код 2 с диагностикой', (t) => {
    const dir = makeDir(t);
    writeCycle(dir, 'bad-schema', metricsDoc({ iterations: 0 }));

    const result = runCli(['--dir', dir]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /bad-schema\/metrics\.json: схема нарушена/u);
  });

  test('нет каталога артефактов и мусор в аргументах — код 2', (t) => {
    const dir = makeDir(t);

    const missing = runCli(['--dir', join(dir, 'nope')]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /каталог артефактов не найден/u);

    for (const args of [['--unknown'], ['--dir']]) {
      const result = runCli(args);
      assert.equal(result.status, 2, args.join(' '));
      assert.notEqual(result.stderr, '');
    }
  });

  test('parseArgs: --dir и --json, мусор — исключение', () => {
    assert.deepEqual(parseArgs([]), { dir: null, json: false });
    assert.deepEqual(parseArgs(['--dir', 'D', '--json']), { dir: 'D', json: true });
    assert.throws(() => parseArgs(['--dir']), /--dir: ожидается путь/u);
    assert.throws(() => parseArgs(['--json', '--wat']), /неизвестный аргумент/u);
  });

  test('listCycleDirs: только подкаталоги с metrics.json, по имени', (t) => {
    const dir = makeDir(t);
    writeCycle(dir, 'b', metricsDoc());
    writeCycle(dir, 'a', metricsDoc());
    mkdirSync(join(dir, 'c'), { recursive: true });
    writeFileSync(join(dir, 'metrics.json'), '{}\n');

    assert.deepEqual(listCycleDirs(dir), ['a', 'b']);
  });
});
