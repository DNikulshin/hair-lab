import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  SCORED_STAGES,
  buildReport,
  extractJsonBlocks,
  positionsOf,
  readStageResult,
  scoreRun,
} from './score.mjs';

/** Сид-дефект: ожидается BLOCKER в указанном файле и строке. */
const defectSeed = {
  id: 'E5',
  expect: { kind: 'defect', severity: 'BLOCKER', file: 'apps/api/src/x.ts', line: 11 },
};

/** Чистый сид: блокеров быть не должно. */
const cleanSeed = { id: 'E10', expect: { kind: 'clean' } };

/**
 * Ответ ревьюера с одним замечанием.
 * @param {{ severity?: string, file?: string, line?: number, inScope?: boolean, preexisting?: boolean }} [finding]
 * @returns {string}
 */
function reviewAnswer(finding = {}) {
  const doc = {
    verdict: 'needs-changes',
    findings: [
      {
        id: 'R1',
        severity: finding.severity ?? 'BLOCKER',
        file: finding.file ?? 'apps/api/src/x.ts',
        line: finding.line ?? 11,
        summary: 'телефон в логе без маскирования',
        repro: 'открыть create-booking.ts',
        in_scope: finding.inScope ?? true,
        preexisting: finding.preexisting ?? false,
      },
    ],
  };
  return `Ревью.\n\n\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\`\n`;
}

/**
 * Ответ оценщика с одним дефектом и полным набором обязательных полей.
 * @param {{ severity?: string, ref?: string }} [defect]
 * @returns {string}
 */
function evaluationAnswer(defect = {}) {
  const doc = {
    verdict: 'REWORK',
    criteria: [{ id: 'C1', status: 'unmet', evidence: [], note: 'ПДн в логе' }],
    scores: {
      coverage: 1,
      correctness: 0,
      tests: null,
      data: null,
      pii_security: 0,
      architecture: null,
      scope: 3,
      docs: null,
      evidence: 2,
    },
    defects: [
      {
        id: 'D1',
        severity: defect.severity ?? 'BLOCKER',
        claim: 'телефон попадает в лог без маскирования',
        evidence: [defect.ref ?? 'apps/api/src/x.ts:11'],
        repro: 'вызвать createBooking и посмотреть лог',
      },
    ],
    unverified: [],
  };
  return `Оценка.\n\n\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\`\n`;
}

describe('extractJsonBlocks', () => {
  test('находит блок json в порядке появления', () => {
    const markdown = '```json\n{"a":1}\n```\nтекст\n```json\n{"b":2}\n```\n';
    assert.deepEqual(extractJsonBlocks(markdown), [{ a: 1 }, { b: 2 }]);
  });

  test('битый блок пропускается, а не роняет разбор', () => {
    const markdown = '```json\n{битый}\n```\n```json\n{"ok":true}\n```\n';
    assert.deepEqual(extractJsonBlocks(markdown), [{ ok: true }]);
  });

  test('другие пометки не считаются блоком результата', () => {
    assert.deepEqual(extractJsonBlocks('```ts\nconst a = 1;\n```\n'), []);
    assert.deepEqual(extractJsonBlocks(''), []);
    assert.deepEqual(extractJsonBlocks(undefined), []);
  });
});

describe('readStageResult', () => {
  test('берёт последний блок, прошедший схему', () => {
    const markdown = `пример:\n\`\`\`json\n{"foo":"bar"}\n\`\`\`\n${reviewAnswer()}`;
    const result = readStageResult(markdown, 'review');
    assert.equal(result.ok, true);
    assert.equal(result.ok === true && result.doc.verdict, 'needs-changes');
  });

  test('пустой ответ и отсутствие блока различаются по причине', () => {
    assert.deepEqual(readStageResult('', 'review'), { ok: false, reason: 'пустой ответ' });
    assert.deepEqual(readStageResult('без блока', 'review'), {
      ok: false,
      reason: 'нет блока ```json',
    });
  });

  test('блок не по схеме — причина с первой ошибкой валидатора', () => {
    const result = readStageResult('```json\n{"verdict":"ok"}\n```\n', 'review');
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : '', /не по схеме/u);
  });
});

describe('positionsOf', () => {
  test('ревью: находки вне скоупа и существовавшие до диффа не участвуют', () => {
    const [doc] = extractJsonBlocks(
      reviewAnswer({ inScope: false }) + reviewAnswer({ preexisting: true }),
    );
    assert.deepEqual(positionsOf('review', doc), []);
  });

  test('оценка: позиция берётся из ссылок evidence', () => {
    const [doc] = extractJsonBlocks(evaluationAnswer({ ref: 'apps/api/src/x.ts:42' }));
    assert.deepEqual(positionsOf('evaluate', doc), [
      { file: 'apps/api/src/x.ts', line: 42, severity: 'BLOCKER' },
    ]);
  });

  test('оценка: несвязанные ссылки (gate:, qa:) позицией не считаются', () => {
    const [doc] = extractJsonBlocks(evaluationAnswer({ ref: 'gate:typecheck' }));
    assert.deepEqual(positionsOf('evaluate', doc), []);
  });
});

describe('scoreRun', () => {
  test('попадание: тот же файл и строка в пределах допуска', () => {
    assert.equal(scoreRun(defectSeed, 'review', reviewAnswer({ line: 14 })).status, 'hit');
    assert.equal(
      scoreRun(defectSeed, 'evaluate', evaluationAnswer({ ref: 'apps/api/src/x.ts:8' })).status,
      'hit',
    );
  });

  test('промах: другой файл или строка вне допуска', () => {
    assert.equal(
      scoreRun(defectSeed, 'review', reviewAnswer({ file: 'apps/api/src/y.ts' })).status,
      'miss',
    );
    assert.equal(scoreRun(defectSeed, 'review', reviewAnswer({ line: 30 })).status, 'miss');
  });

  test('severities: попадание по любому значению из набора', () => {
    const scopeSeed = {
      id: 'E1',
      expect: {
        kind: 'defect',
        severities: ['MAJOR', 'FOLLOW-UP'],
        file: 'apps/api/src/x.ts',
        line: 11,
      },
    };
    assert.equal(scoreRun(scopeSeed, 'review', reviewAnswer({ severity: 'MAJOR' })).status, 'hit');
    assert.equal(
      scoreRun(scopeSeed, 'review', reviewAnswer({ severity: 'FOLLOW-UP' })).status,
      'hit',
    );
    // BLOCKER в набор не входит: сид требует назвать границы, а не эскалировать.
    assert.equal(
      scoreRun(scopeSeed, 'review', reviewAnswer({ severity: 'BLOCKER' })).status,
      'miss',
    );
  });

  test('серьёзность ниже ожидаемой — промах', () => {
    assert.equal(
      scoreRun(defectSeed, 'review', reviewAnswer({ severity: 'MINOR' })).status,
      'miss',
    );
    assert.equal(
      scoreRun(defectSeed, 'review', reviewAnswer({ severity: 'MAJOR' })).status,
      'miss',
    );
  });

  test('неразобранный ответ — invalid, а не промах', () => {
    const result = scoreRun(defectSeed, 'review', 'агент ничего не ответил');
    assert.equal(result.status, 'invalid');
    assert.match(result.reason, /нет блока/u);
  });

  test('чистый сид: блокер — ложная блокировка, мелочь — нет', () => {
    assert.equal(scoreRun(cleanSeed, 'review', reviewAnswer()).status, 'false_positive');
    assert.equal(
      scoreRun(cleanSeed, 'review', reviewAnswer({ severity: 'MINOR' })).status,
      'clean',
    );
    const empty = '```json\n{"verdict":"merge-ready","findings":[]}\n```\n';
    assert.equal(scoreRun(cleanSeed, 'review', empty).status, 'clean');
  });

  test('этапы в прогонах — только review и evaluate', () => {
    assert.deepEqual([...SCORED_STAGES], ['review', 'evaluate']);
  });
});

describe('buildReport', () => {
  const seeds = { E5: 'defect', E6: 'defect', E10: 'clean' };
  const thresholds = { completeness: 0.8, false_positive_max: 0.2 };

  test('полнота считается по объединению этапов, уникальные попадания — по этапам', () => {
    const report = buildReport({
      seeds,
      thresholds,
      runs: [
        { config: 'a', seed: 'E5', stage: 'review', status: 'hit' },
        { config: 'a', seed: 'E5', stage: 'evaluate', status: 'miss' },
        { config: 'a', seed: 'E6', stage: 'review', status: 'miss' },
        { config: 'a', seed: 'E6', stage: 'evaluate', status: 'miss' },
        { config: 'a', seed: 'E10', stage: 'review', status: 'clean' },
        { config: 'a', seed: 'E10', stage: 'evaluate', status: 'clean' },
      ],
    });

    assert.equal(report.configs.a.summary.hits, 1);
    assert.equal(report.configs.a.summary.misses, 1);
    assert.equal(report.configs.a.summary.completeness, 0.5);
    assert.equal(report.configs.a.summary.exclusive.review, 1);
    assert.equal(report.configs.a.summary.exclusive.evaluate, 0);
    assert.equal(report.configs.a.summary.false_positive_rate, 0);
    assert.equal(report.verdict, 'below_threshold');
    assert.match(report.failures.join('\n'), /полнота 0\.50 < 0\.8/u);
  });

  test('ложные блокировки на чистом сиде считаются отдельно', () => {
    const report = buildReport({
      seeds,
      thresholds,
      runs: [
        { config: 'a', seed: 'E10', stage: 'review', status: 'false_positive' },
        { config: 'a', seed: 'E10', stage: 'evaluate', status: 'clean' },
        { config: 'a', seed: 'E5', stage: 'review', status: 'hit' },
        { config: 'a', seed: 'E6', stage: 'evaluate', status: 'hit' },
      ],
    });
    assert.equal(report.configs.a.summary.false_positives, 1);
    assert.equal(report.configs.a.summary.clean_runs, 1);
    assert.equal(report.configs.a.summary.false_positive_rate, 1);
    assert.match(report.failures.join('\n'), /ложные блокировки 1\.00 > 0\.2/u);
  });

  test('сид, где все ответы не разобрались, не считается ни попаданием, ни промахом', () => {
    const report = buildReport({
      seeds,
      thresholds,
      runs: [
        { config: 'a', seed: 'E5', stage: 'review', status: 'invalid' },
        { config: 'a', seed: 'E5', stage: 'evaluate', status: 'invalid' },
      ],
    });
    assert.equal(report.configs.a.summary.hits, 0);
    assert.equal(report.configs.a.summary.misses, 0);
    assert.equal(report.configs.a.summary.completeness, null);
    assert.equal(report.configs.a.by_seed.E5.union, 'invalid');
    assert.equal(report.verdict, 'ok');
  });

  test('стоимость усредняется только по прогонам с известным usage', () => {
    const report = buildReport({
      seeds,
      thresholds,
      runs: [
        { config: 'a', seed: 'E5', stage: 'review', status: 'hit', cost_rub: 1 },
        { config: 'a', seed: 'E5', stage: 'evaluate', status: 'hit', cost_rub: 3 },
        { config: 'a', seed: 'E6', stage: 'review', status: 'hit', cost_rub: null },
      ],
    });
    assert.equal(report.configs.a.cost_known, 2);
    assert.equal(report.configs.a.summary.avg_cost_rub, 2);
  });

  test('конфигурации сравниваются независимо: у каждой свой вердикт', () => {
    const report = buildReport({
      seeds,
      thresholds,
      runs: [
        { config: 'a', seed: 'E5', stage: 'review', status: 'hit' },
        { config: 'a', seed: 'E6', stage: 'review', status: 'hit' },
        { config: 'b', seed: 'E5', stage: 'review', status: 'miss' },
        { config: 'b', seed: 'E6', stage: 'review', status: 'miss' },
      ],
    });
    assert.equal(report.configs.a.summary.completeness, 1);
    assert.equal(report.configs.b.summary.completeness, 0);
    assert.deepEqual(
      report.failures.map((item) => item.split(':')[0]),
      ['b'],
    );
  });
});
