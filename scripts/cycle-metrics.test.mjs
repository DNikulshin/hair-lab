import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LINE_TOLERANCE,
  buildMetrics,
  evaluatorSharesFamilyWithPlan,
  matchFindings,
  normalizeUsage,
  parseArgs,
  priceKeyFor,
  priceUsage,
  resolveCycleDir,
} from './cycle-metrics.mjs';
import { validateMetrics } from './lib/cycle/validate.mjs';

/** Путь к CLI: сквозные тесты запускают его отдельным процессом, как супервизор. */
const SCRIPT = fileURLToPath(new URL('./cycle-metrics.mjs', import.meta.url));

/** Каталог фикстур метрик: `scripts/fixtures/cycle/metrics/`. */
const FIXTURES = fileURLToPath(new URL('./fixtures/cycle/metrics/', import.meta.url));

/** Корень репозитория: CLI определяет его сам, тесты — для временных каталогов. */
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * Запуск CLI в корне репозитория.
 * @param {string[]} args
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

/**
 * Копия фикстуры во временном каталоге: CLI пишет `metrics.json`, а фикстуры
 * репозитория должны остаться нетронутыми (§5.10).
 * @param {string} name имя каталога в `scripts/fixtures/cycle/metrics/`
 * @returns {string} путь копии
 */
function tempCopy(name) {
  const dir = join(mkdtempSync(join(tmpdir(), 'hair-lab-metrics-')), name);
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

/**
 * Прогон CLI на временной копии фикстуры.
 * @param {string} name каталог фикстуры
 * @returns {{ status: number|null, stdout: string, stderr: string, dir: string }}
 */
function runFixture(name) {
  const dir = tempCopy(name);
  return { ...runCli(['--dir', dir]), dir };
}

/**
 * `metrics.json`, записанный CLI для фикстуры, плюс сам прогон.
 * @param {string} name каталог фикстуры
 * @returns {{ text: string, doc: any, status: number|null, stdout: string, stderr: string }}
 */
function metricsOf(name) {
  const run = runFixture(name);
  assert.equal(run.status, 0, run.stderr);
  const text = readFileSync(join(run.dir, 'metrics.json'), 'utf8');
  return { ...run, text, doc: JSON.parse(text) };
}

/**
 * Запись `state.history[]`.
 * @param {string} stage
 * @param {string} started_at
 * @param {string|null} finished_at
 * @returns {any}
 */
function entry(stage, started_at, finished_at) {
  return {
    stage,
    iteration: 1,
    started_at,
    finished_at,
    status: finished_at === null ? 'running' : 'done',
  };
}

/**
 * Метрики по одной истории без гейтов и артефактов анализа.
 * @param {any[]} history
 * @param {{ models?: Record<string, string> }} [options]
 * @returns {any}
 */
function metricsFor(history, { models = {} } = {}) {
  return buildMetrics({
    state: { iteration: 1, max_iterations: 2, stage: 'DONE', models, history },
    iterations: [],
  });
}

describe('buildMetrics: длительности этапов', () => {
  test('суммирует записи одного этапа по всем итерациям', () => {
    const metrics = buildMetrics({
      state: {
        iteration: 2,
        max_iterations: 2,
        stage: 'DONE',
        models: {},
        history: [
          entry('CODE', '2026-11-16T21:20:00Z', '2026-11-16T21:50:00Z'),
          entry('CODE', '2026-11-16T22:10:10Z', '2026-11-16T22:40:00Z'),
          entry('GATES', '2026-11-16T22:40:00Z', '2026-11-16T22:45:00Z'),
        ],
      },
      iterations: [],
    });

    assert.equal(metrics.stage_durations_s.CODE, 3590, '1800 + 1790 секунд');
    assert.equal(metrics.stage_durations_s.GATES, 300);
    assert.equal(metrics.cycle_duration_s, 3890);
    assert.equal(metrics.unclosed_stages, 0);
  });

  test('запись без finished_at не считается и видна в unclosed_stages', () => {
    const metrics = metricsFor([
      entry('INIT', '2026-11-16T09:00:00Z', '2026-11-16T09:01:00Z'),
      entry('CODE', '2026-11-16T09:05:00Z', null),
    ]);

    assert.deepEqual(metrics.stage_durations_s, { INIT: 60 });
    assert.equal(metrics.unclosed_stages, 1);
    assert.equal(metrics.cycle_duration_s, 60);
  });

  test('полночь и смещение +03:00 не меняют длительность', () => {
    const midnight = metricsFor([
      entry('INIT', '2026-11-16T23:58:00+03:00', '2026-11-17T00:00:30+03:00'),
    ]);
    const utc = metricsFor([entry('INIT', '2026-11-16T20:58:00Z', '2026-11-16T21:00:30Z')]);

    assert.equal(midnight.stage_durations_s.INIT, 150);
    assert.equal(utc.stage_durations_s.INIT, 150);
  });

  test('разные смещения одного момента дают 0, а не -0', () => {
    const metrics = metricsFor([
      entry('GATES', '2026-11-16T21:00:00Z', '2026-11-17T00:00:00+03:00'),
    ]);

    assert.equal(metrics.stage_durations_s.GATES, 0);
    assert.ok(Object.is(metrics.stage_durations_s.GATES, 0), 'ожидался положительный ноль');
    assert.ok(Object.is(metrics.cycle_duration_s, 0), 'ожидался положительный ноль');
  });

  test('округляет до миллисекунд и не оставляет хвостов плавающей точки', () => {
    const metrics = metricsFor([
      entry('PLAN', '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.100Z'),
      entry('PLAN', '2026-11-16T00:00:00.200Z', '2026-11-16T00:00:00.400Z'),
    ]);

    assert.equal(metrics.stage_durations_s.PLAN, 0.3);
    assert.equal(metrics.cycle_duration_s, 0.3);
  });

  test('битая дата — исключение с указанием записи, а не тихий ноль', () => {
    assert.throws(
      () => metricsFor([entry('INIT', 'вчера', '2026-11-16T09:01:00Z')]),
      /state\.history\[0\]\.started_at: не разбирается как дата ISO-8601/,
    );
    assert.throws(
      () =>
        metricsFor([
          entry('INIT', '2026-11-16T09:00:00Z', '2026-11-16T09:01:00Z'),
          entry('PLAN', '2026-11-16T09:01:00Z', '2026-13-01T09:05:00Z'),
        ]),
      /state\.history\[1\]\.finished_at: не разбирается как дата ISO-8601/,
    );
  });

  test('finished_at раньше started_at — исключение', () => {
    assert.throws(
      () => metricsFor([entry('CODE', '2026-11-16T09:05:00Z', '2026-11-16T09:00:00Z')]),
      /state\.history\[0\]: finished_at раньше started_at/,
    );
  });
});

describe('buildMetrics: гейты, находки и решения', () => {
  /**
   * Гейт с минимальным набором полей.
   * @param {string} id
   * @param {string} status
   * @param {number} duration_s
   * @returns {any}
   */
  function gate(id, status, duration_s) {
    return {
      id,
      status,
      duration_s,
      required: true,
      cmd: `cmd ${id}`,
      exit: null,
      log: null,
      reason: null,
    };
  }

  test('суммирует длительности и исходы гейтов по итерациям', () => {
    const metrics = buildMetrics({
      state: { iteration: 2, max_iterations: 2, stage: 'DONE', models: {}, history: [] },
      iterations: [
        {
          iteration: 1,
          gates: { gates: [gate('lint', 'fail', 0.1), gate('typecheck', 'pass', 1)] },
          review: null,
          evaluation: null,
          decision: null,
        },
        {
          iteration: 2,
          gates: { gates: [gate('lint', 'pass', 0.2), gate('typecheck', 'skipped', 0)] },
          review: null,
          evaluation: null,
          decision: null,
        },
      ],
    });

    assert.deepEqual(metrics.gate_durations_s, { lint: 0.3, typecheck: 1 });
    assert.equal(metrics.gate_total_s, 1.3);
    assert.deepEqual(metrics.gate_outcomes.lint, { pass: 1, fail: 1, skipped: 0, not_run: 0 });
    assert.deepEqual(metrics.gate_outcomes.typecheck, { pass: 1, fail: 0, skipped: 1, not_run: 0 });
  });

  test('итерация без review, evaluation и decision даёт нули', () => {
    const metrics = buildMetrics({
      state: { iteration: 1, max_iterations: 2, stage: 'ESCALATED', models: {}, history: [] },
      iterations: [
        {
          iteration: 1,
          gates: { gates: [gate('typecheck', 'not_run', 0)] },
          review: null,
          evaluation: null,
          decision: null,
        },
      ],
    });

    assert.deepEqual(metrics.review_findings, { BLOCKER: 0, MAJOR: 0, MINOR: 0, 'FOLLOW-UP': 0 });
    assert.deepEqual(metrics.evaluator_defects, { BLOCKER: 0, MAJOR: 0, MINOR: 0 });
    assert.deepEqual(
      {
        only_review: metrics.only_review,
        only_evaluator: metrics.only_evaluator,
        both: metrics.both,
      },
      { only_review: 0, only_evaluator: 0, both: 0 },
    );
    assert.equal(metrics.unresolved_refs, 0);
    assert.equal(metrics.verdict_without_evidence, 0);
    assert.deepEqual(metrics.gate_outcomes.typecheck, { pass: 0, fail: 0, skipped: 0, not_run: 1 });
    assert.equal(metrics.final_stage, 'ESCALATED');
  });

  test('считает серьёзность находок и дефектов, суммы решений', () => {
    const metrics = buildMetrics({
      state: { iteration: 2, max_iterations: 2, stage: 'DONE', models: {}, history: [] },
      iterations: [
        {
          iteration: 1,
          gates: { gates: [] },
          review: {
            verdict: 'needs-changes',
            findings: [
              { id: 'R1', severity: 'BLOCKER', file: 'a.mjs', line: 1 },
              { id: 'R2', severity: 'MINOR', file: '', line: '' },
            ],
          },
          evaluation: {
            verdict: 'REWORK',
            defects: [
              { id: 'D1', severity: 'BLOCKER', evidence: ['a.mjs:1'] },
              { id: 'D2', severity: 'MINOR', evidence: [] },
            ],
          },
          decision: { unresolved_refs: 2, counts: { verdict_without_evidence: 1 } },
        },
        {
          iteration: 2,
          gates: { gates: [] },
          review: { verdict: 'merge-ready', findings: [{ id: 'R3', severity: 'FOLLOW-UP' }] },
          evaluation: {
            verdict: 'ACCEPT',
            defects: [{ id: 'D3', severity: 'MAJOR', evidence: [] }],
          },
          decision: { unresolved_refs: 0 },
        },
      ],
    });

    assert.deepEqual(metrics.review_findings, { BLOCKER: 1, MAJOR: 0, MINOR: 1, 'FOLLOW-UP': 1 });
    assert.deepEqual(metrics.evaluator_defects, { BLOCKER: 1, MAJOR: 1, MINOR: 1 });
    assert.equal(metrics.unresolved_refs, 2);
    assert.equal(metrics.verdict_without_evidence, 1, 'у decision.2 нет counts — вклад 0');
    assert.equal(metrics.both, 1, 'R1 совпал с D1');
  });

  test('нечисловая длительность гейта — исключение, а не ноль', () => {
    assert.throws(
      () =>
        buildMetrics({
          state: { iteration: 1, max_iterations: 2, stage: 'DONE', models: {}, history: [] },
          iterations: [
            {
              iteration: 1,
              gates: { gates: [{ id: 'lint', status: 'pass', duration_s: null }] },
              review: null,
              evaluation: null,
              decision: null,
            },
          ],
        }),
      /gates\.1\.gates\[0\]\.duration_s: ожидается число ≥ 0/,
    );
  });
});

describe('matchFindings: правило §5.6', () => {
  /**
   * Находка ревью на позиции.
   * @param {number|string|null} line
   * @param {{ file?: string, preexisting?: boolean }} [options]
   * @returns {any}
   */
  function finding(line, { file = 'scripts/a.mjs', preexisting = false } = {}) {
    return { id: 'R1', severity: 'MINOR', file, line, preexisting };
  }

  /**
   * Дефект оценщика со ссылкой в свидетельстве.
   * @param {string} ref
   * @returns {any}
   */
  function defect(ref) {
    return { id: 'D1', severity: 'MAJOR', evidence: [ref] };
  }

  test(`разница строк ≤ ${LINE_TOLERANCE} — оба, больше — только одна сторона`, () => {
    const cases = [
      { delta: 0, expected: { only_review: 0, only_evaluator: 0, both: 1 } },
      { delta: 5, expected: { only_review: 0, only_evaluator: 0, both: 1 } },
      { delta: -5, expected: { only_review: 0, only_evaluator: 0, both: 1 } },
      { delta: 6, expected: { only_review: 1, only_evaluator: 1, both: 0 } },
      { delta: -6, expected: { only_review: 1, only_evaluator: 1, both: 0 } },
    ];

    for (const { delta, expected } of cases) {
      const review = { findings: [finding(100)] };
      const evaluation = { defects: [defect(`scripts/a.mjs:${100 + delta}`)] };
      assert.deepEqual(matchFindings(review, evaluation), expected, `Δline = ${delta}`);
    }
  });

  test('другой файл не сопоставляется', () => {
    const review = { findings: [finding(100)] };
    const evaluation = { defects: [defect('scripts/b.mjs:100')] };

    assert.deepEqual(matchFindings(review, evaluation), {
      only_review: 1,
      only_evaluator: 1,
      both: 0,
    });
  });

  test('пустые и нецелые file/line не сопоставляются', () => {
    for (const line of ['', null, '100', 1.5, 0, -1, undefined]) {
      const review = { findings: [finding(line)] };
      const evaluation = { defects: [defect('scripts/a.mjs:1')] };
      assert.deepEqual(
        matchFindings(review, evaluation),
        { only_review: 1, only_evaluator: 1, both: 0 },
        `line = ${JSON.stringify(line)}`,
      );
    }

    const emptyFile = { findings: [finding(1, { file: '   ' })] };
    assert.equal(matchFindings(emptyFile, { defects: [defect('scripts/a.mjs:1')] }).both, 0);
  });

  test('дефект без разбираемых ссылок — only_evaluator', () => {
    const review = { findings: [finding(10)] };
    const evaluation = { defects: [{ id: 'D1', severity: 'MAJOR', evidence: ['gate:lint'] }] };

    assert.deepEqual(matchFindings(review, evaluation), {
      only_review: 1,
      only_evaluator: 1,
      both: 0,
    });
  });

  test('каждый элемент участвует один раз', () => {
    const review = { findings: [finding(100), finding(101)] };
    const evaluation = { defects: [defect('scripts/a.mjs:100')] };

    assert.deepEqual(matchFindings(review, evaluation), {
      only_review: 1,
      only_evaluator: 0,
      both: 1,
    });
  });

  test('preexisting участвует в сопоставлении', () => {
    const review = { findings: [finding(100, { preexisting: true })] };
    const evaluation = { defects: [defect('scripts/a.mjs:100')] };

    assert.equal(matchFindings(review, evaluation).both, 1);
  });

  test('нет артефактов — нули', () => {
    const empty = { only_review: 0, only_evaluator: 0, both: 0 };

    assert.deepEqual(matchFindings(null, null), empty);
    assert.deepEqual(matchFindings({ findings: [] }, undefined), empty);
  });
});

describe('evaluatorSharesFamilyWithPlan', () => {
  test('семейство оценщика совпадает с планом', () => {
    assert.equal(
      evaluatorSharesFamilyWithPlan({
        plan: 'polza-ai/deepseek/planner-lite',
        evaluate: 'polza-ai/deepseek/evaluator-lite',
      }),
      true,
    );
  });

  test('разные семейства — false', () => {
    assert.equal(
      evaluatorSharesFamilyWithPlan({
        plan: 'polza-ai/deepseek/planner-lite',
        evaluate: 'polza-ai/openai/evaluator-lite',
      }),
      false,
    );
  });

  test('ключа evaluate нет — true по R2 (до T7 оценивает ревьюер)', () => {
    assert.equal(
      evaluatorSharesFamilyWithPlan({
        plan: 'polza-ai/deepseek/planner-lite',
        code: 'polza-ai/deepseek/coder-lite',
        review: 'polza-ai/openai/reviewer-lite',
      }),
      true,
    );
  });

  test('семейство не вычисляется — true (неопределённость не выдаётся за независимость)', () => {
    assert.equal(
      evaluatorSharesFamilyWithPlan({ plan: 'vendor/plan-model', evaluate: 'polza-ai/x/y' }),
      true,
    );
    assert.equal(
      evaluatorSharesFamilyWithPlan({ plan: 'polza-ai/deepseek/p', evaluate: 'evaluator' }),
      true,
    );
    assert.equal(evaluatorSharesFamilyWithPlan(null), true);
  });
});

/**
 * Отсутствует ли `metrics.json` в каталоге: при ошибке артефакт писаться не должен.
 * @param {string} dir
 * @returns {boolean}
 */
function metricsMissing(dir) {
  try {
    readFileSync(join(dir, 'metrics.json'));
    return false;
  } catch {
    return true;
  }
}

describe('CLI: cycle-metrics', () => {
  test('полный цикл: metrics.json совпадает с metrics.valid.json байт-в-байт', () => {
    const { text, stdout, doc } = metricsOf('full-cycle');
    const expected = readFileSync(join(FIXTURES, 'metrics.valid.json'), 'utf8');

    assert.equal(text, expected);
    assert.equal(
      stdout,
      `${JSON.stringify(doc)}\n`,
      'в stdout — одна строка JSON того же документа',
    );
    assert.deepEqual(validateMetrics(doc), { ok: true, errors: [] });
    assert.equal(doc.tokens, null);
    assert.equal(doc.cost_rub, null);
  });

  test('агрегаты полного цикла: длительности, гейты, счётчики', () => {
    const { doc } = metricsOf('full-cycle');

    assert.equal(doc.iterations, 2);
    assert.equal(doc.final_stage, 'DONE');
    assert.equal(doc.cycle_duration_s, 6750, 'сумма длительностей этапов, без пауз супервизора');
    assert.equal(doc.unclosed_stages, 1, 'PR-запись без finished_at');
    assert.equal(doc.gate_total_s, 245.35);
    assert.deepEqual(doc.gate_outcomes.lint, { pass: 1, fail: 1, skipped: 0, not_run: 0 });
    assert.deepEqual(doc.review_findings, { BLOCKER: 1, MAJOR: 1, MINOR: 2, 'FOLLOW-UP': 2 });
    assert.deepEqual(doc.evaluator_defects, { BLOCKER: 1, MAJOR: 2, MINOR: 1 });
    assert.deepEqual(
      { only_review: doc.only_review, only_evaluator: doc.only_evaluator, both: doc.both },
      { only_review: 4, only_evaluator: 2, both: 2 },
    );
    assert.equal(doc.unresolved_refs, 2);
    assert.equal(doc.verdict_without_evidence, 1);
  });

  test('детерминизм: повторный прогон даёт побайтно тот же файл', () => {
    const run = runFixture('full-cycle');
    assert.equal(run.status, 0, run.stderr);
    const file = join(run.dir, 'metrics.json');
    const first = readFileSync(file, 'utf8');

    const second = runCli(['--dir', run.dir]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(file, 'utf8'), first);
    assert.equal(second.stdout, run.stdout);

    rmSync(run.dir, { recursive: true, force: true });
  });

  test('итерация без review/evaluation/decision: код 0 и нули в счётчиках', () => {
    const { doc } = metricsOf('no-review');

    assert.equal(doc.final_stage, 'ESCALATED');
    assert.deepEqual(
      { only_review: doc.only_review, only_evaluator: doc.only_evaluator, both: doc.both },
      { only_review: 0, only_evaluator: 0, both: 0 },
    );
    assert.deepEqual(doc.review_findings, { BLOCKER: 0, MAJOR: 0, MINOR: 0, 'FOLLOW-UP': 0 });
    assert.equal(doc.unresolved_refs, 0);
    assert.equal(doc.unclosed_stages, 0);
    assert.equal(doc.gate_total_s, 10);
    assert.deepEqual(doc.gate_outcomes.typecheck, { pass: 0, fail: 0, skipped: 0, not_run: 1 });
    assert.equal(doc.evaluator_shares_family_with_plan, true);
  });

  test('нет gates.<n>.json — код 2 и имя артефакта в stderr без абсолютного пути', () => {
    const dir = tempCopy('no-review');
    rmSync(join(dir, 'gates.1.json'));

    const result = runCli(['--dir', dir]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /cycle-metrics: gates\.1\.json: не читается/);
    assert.ok(!result.stderr.includes(dir), 'в диагностике не должно быть абсолютного пути');
    assert.doesNotMatch(result.stderr, /\n\s+at\s/);
  });

  test('невозможная дата в history — код 2 с указанием записи, а не тихий ноль', () => {
    const dir = tempCopy('no-review');
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    state.history[0].started_at = '2026-02-30T09:00:00Z';
    writeFileSync(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);

    const result = runCli(['--dir', dir]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /state\.history\[0\]\.started_at: невозможные дата или время/);
    assert.ok(!result.stderr.includes(dir), 'в диагностике не должно быть абсолютного пути');
    assert.ok(metricsMissing(dir), 'при ошибке metrics.json не пишется');
  });

  test('битый review.<n>.json — код 2 (повреждённый артефакт не искажает метрику молча)', () => {
    const dir = tempCopy('full-cycle');
    writeFileSync(join(dir, 'review.2.json'), '{"verdict": "merge-ready", "findings": [}\n');

    const result = runCli(['--dir', dir]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /review\.2\.json: не читается/);
    assert.ok(!result.stderr.includes(dir));
  });

  test('неизвестный аргумент и --dir без значения — код 2', () => {
    for (const args of [['--iteration', '1'], ['--dir']]) {
      const result = runCli(args);
      assert.equal(result.status, 2);
      assert.match(result.stderr, /^cycle-metrics: /);
    }
  });
});

describe('resolveCycleDir и parseArgs', () => {
  test('--dir обязателен по форме и не принимает мусор', () => {
    assert.deepEqual(parseArgs(['--dir', 'цикл']), { dir: 'цикл' });
    assert.deepEqual(parseArgs([]), { dir: null });
    assert.throws(() => parseArgs(['--dir', '--dir']), /--dir: ожидается путь к каталогу цикла/);
    assert.throws(() => parseArgs(['--dir', '  ']), /--dir: ожидается путь/);
    assert.throws(() => parseArgs(['--verbose']), /неизвестный аргумент: --verbose/);
  });

  test('без активного цикла сообщение содержит относительный путь', () => {
    const root = mkdtempSync(join(tmpdir(), 'hair-lab-metrics-root-'));
    mkdirSync(join(root, '.pi', 'artifacts', 'завершён'), { recursive: true });

    assert.throws(
      () => resolveCycleDir(root),
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.ok(
          message.includes(join('.pi', 'artifacts')),
          `ожидался относительный путь: ${message}`,
        );
        assert.ok(!message.includes(root), 'абсолютный путь в сообщении не нужен');
        return true;
      },
    );
  });

  test('находит единственный незавершённый цикл', () => {
    const root = mkdtempSync(join(tmpdir(), 'hair-lab-metrics-root-'));
    const dir = join(root, '.pi', 'artifacts', '2026-11-16-160-cycle-metrics');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), '{"stage": "CODE"}\n');

    assert.equal(resolveCycleDir(root), dir);
  });
});

describe('normalizeUsage', () => {
  test('приводит расход к целым и дополняет отсутствующие поля нулями', () => {
    assert.deepEqual(normalizeUsage({ plan: { runs: 1, input: 10, cache_read: 20, output: 30 } }), {
      plan: { runs: 1, input: 10, cache_read: 20, cache_write: 0, output: 30, reasoning: 0 },
    });
  });

  test('неизвестный этап и отрицательные значения — отказ, а не тихий ноль', () => {
    assert.throws(() => normalizeUsage({ gates: { runs: 1 } }), /неизвестный этап gates/u);
    assert.throws(() => normalizeUsage({ code: { runs: -1 } }), /usage\.json\.code\.runs/u);
    assert.throws(() => normalizeUsage(null), /ожидается объект этапов/u);
  });
});

describe('priceKeyFor', () => {
  const prices = { 'z-ai/glm-5.3': { input: 1, output: 2, cache_read: 3, cache_write: 0 } };

  test('находит модель с префиксом провайдера: в state.models он есть, в prices нет', () => {
    assert.equal(priceKeyFor('polza-ai/z-ai/glm-5.3', prices), 'z-ai/glm-5.3');
  });

  test('точное совпадение проверяется первым', () => {
    assert.equal(priceKeyFor('z-ai/glm-5.3', prices), 'z-ai/glm-5.3');
  });

  test('неизвестная модель и мусор дают null', () => {
    assert.equal(priceKeyFor('polza-ai/nope/nope', prices), null);
    assert.equal(priceKeyFor('', prices), null);
    assert.equal(priceKeyFor(null, prices), null);
  });
});

describe('priceUsage', () => {
  /** Снапшот цен: 10 ₽ за 1M входа, 100 ₽ за 1M вывода, 1 ₽ за 1M чтения кэша. */
  const prices = {
    'm/a': { input: 10, output: 100, cache_read: 1, cache_write: 0, context: 1000 },
  };
  const models = { plan: 'm/a', code: 'm/a', review: 'm/a', evaluate: 'm/a' };

  test('складывает стадии и округляет до копеек', () => {
    const tokens = {
      plan: { runs: 1, input: 1_000_000, cache_read: 0, cache_write: 0, output: 0, reasoning: 0 },
      code: { runs: 2, input: 0, cache_read: 1_000_000, cache_write: 0, output: 0, reasoning: 0 },
    };
    // 10 ₽ за вход плана + 1 ₽ за кэш кода.
    assert.equal(priceUsage(tokens, models, prices), 11);
  });

  test('модель с префиксом провайдера в state.models считается по ценам без префикса', () => {
    const tokens = {
      plan: { runs: 1, input: 1_000_000, cache_read: 0, cache_write: 0, output: 0, reasoning: 0 },
    };
    assert.equal(priceUsage(tokens, { plan: 'polza-ai/m/a' }, prices), 10);
  });

  test('нет замера, нет модели или нет цен — null, а не ноль', () => {
    const tokens = {
      plan: { runs: 1, input: 1, cache_read: 0, cache_write: 0, output: 0, reasoning: 0 },
    };
    assert.equal(priceUsage({}, models, prices), null);
    assert.equal(priceUsage(tokens, { plan: 'm/unknown' }, prices), null);
    assert.equal(priceUsage(tokens, {}, prices), null);
    assert.equal(priceUsage(tokens, models, {}), null);
  });
});

describe('buildMetrics: расход и стоимость', () => {
  const usage = {
    plan: { runs: 1, input: 1_000_000, cache_read: 0, cache_write: 0, output: 0, reasoning: 0 },
  };
  const prices = { 'm/a': { input: 10, output: 100, cache_read: 1, cache_write: 0, context: 1 } };
  const state = {
    iteration: 1,
    max_iterations: 2,
    stage: 'DONE',
    history: [],
    models: { plan: 'm/a' },
  };

  test('без usage токены и стоимость — null: это отсутствие замера, а не ноль', () => {
    const metrics = buildMetrics({ state, iterations: [] });
    assert.equal(metrics.tokens, null);
    assert.equal(metrics.cost_rub, null);
  });

  test('с usage заполняются токены, стоимость считается по моделям этапов', () => {
    const metrics = buildMetrics({ state, iterations: [], usage, prices });
    assert.deepEqual(metrics.tokens.plan, {
      runs: 1,
      input: 1_000_000,
      cache_read: 0,
      cache_write: 0,
      output: 0,
      reasoning: 0,
    });
    assert.equal(metrics.cost_rub, 10);
    assert.equal(validateMetrics(metrics).ok, true);
  });

  test('usage без цен оставляет токены и обнуляет стоимость', () => {
    const metrics = buildMetrics({ state, iterations: [], usage });
    assert.ok(metrics.tokens !== null);
    assert.equal(metrics.cost_rub, null);
    assert.equal(validateMetrics(metrics).ok, true);
  });
});
