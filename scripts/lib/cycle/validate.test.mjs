import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  validateDecision,
  validateEscalation,
  validateEvaluation,
  validateGates,
  validateMetrics,
  validateQaWeb,
  validateReview,
  validateState,
} from './validate.mjs';

/** Корень фикстур схем: `scripts/fixtures/cycle/`. */
const FIXTURES = new URL('../../fixtures/cycle/', import.meta.url);

/**
 * Разобранный JSON-фикстур.
 * @param {string} name имя файла
 * @returns {any}
 */
function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
}

/**
 * Все ошибки одной строкой: по ней удобно проверять конкретные нарушения.
 * @param {{ errors: string[] }} result
 * @returns {string}
 */
function messages(result) {
  return result.errors.join('\n');
}

/**
 * Ожидание «документ невалиден и в ошибках есть такой текст».
 * @param {{ ok: boolean, errors: string[] }} result
 * @param {RegExp} pattern
 * @returns {void}
 */
function assertInvalidWith(result, pattern) {
  assert.equal(result.ok, false, `ожидались ошибки, получено: ${messages(result)}`);
  assert.match(messages(result), pattern);
}

/**
 * Ожидание «фикстура ломает ровно одно правило»: одна ошибка, и она про ожидаемое поле.
 * @param {{ ok: boolean, errors: string[] }} result
 * @param {RegExp} pattern
 * @returns {void}
 */
function assertSingleError(result, pattern) {
  assert.equal(result.ok, false, 'ожидались ошибки, документ прошёл валидацию');
  assert.equal(result.errors.length, 1, `ожидалась одна ошибка: ${messages(result)}`);
  assert.match(result.errors[0], pattern);
}

/**
 * Регистрирует по тесту на каждую invalid-фикстуру схемы: файл ломает ровно одно правило
 * Приложения A, поэтому в результате ровно одна ошибка — тест изолирует нарушение.
 * @param {(doc: unknown) => { ok: boolean, errors: string[] }} validate
 * @param {Record<string, RegExp>} cases файл → ожидаемая ошибка
 * @returns {void}
 */
function checkInvalidFixtures(validate, cases) {
  for (const [name, pattern] of Object.entries(cases)) {
    test(`${name}: нарушено ровно одно правило`, () => {
      assertSingleError(validate(fixture(name)), pattern);
    });
  }
}

/** Нарушения `state.json`: по одному на файл. */
const STATE_INVALID = {
  'state.invalid.issue.json': /state\.issue: ожидается целое ≥ 1/,
  'state.invalid.slug.json': /state\.slug: значение не соответствует шаблону/,
  'state.invalid.base-sha.json': /state\.base_sha: значение не соответствует шаблону/,
  'state.invalid.stage.json': /state\.stage: ожидается одно из INIT\|PLAN/,
  'state.invalid.stage-status.json': /state\.stage_status: ожидается одно из pending\|running/,
  'state.invalid.criteria-source.json': /state\.criteria_source: ожидается одно из issue/,
  'state.invalid.retries.json': /state\.retries\.EVALUATE: ожидается целое ≥ 0/,
  'state.invalid.models.json': /state\.models\.code: ожидается строка/,
  'state.invalid.history-stage.json': /state\.history\[0\]\.stage: ожидается одно из INIT/,
  'state.invalid.history-started-at.json':
    /state\.history\[0\]\.started_at: значение не соответствует шаблону/,
  'state.invalid.history-status.json': /state\.history\[0\]\.status: обязательное поле/,
  'state.invalid.escalation-reason.json':
    /state\.escalation\.reason: ожидается одно из criteria_missing/,
  'state.invalid.escalation-draft-pr.json':
    /state\.escalation\.draft_pr_allowed: ожидается boolean/,
  'state.invalid.updated-at.json': /state\.updated_at: обязательное поле отсутствует/,
};

/** Нарушения `gates.<n>.json`: по одному на файл. */
const GATES_INVALID = {
  'gates.invalid.iteration.json': /gates\.iteration: ожидается целое ≥ 1/,
  'gates.invalid.base-sha.json': /gates\.base_sha: значение не соответствует шаблону/,
  'gates.invalid.head.json': /gates\.head: обязательное поле отсутствует/,
  'gates.invalid.started-at.json': /gates\.started_at: значение не соответствует шаблону/,
  'gates.invalid.gate-id.json': /gates\.gates\[0\]\.id: значение не соответствует шаблону/,
  'gates.invalid.gate-cmd.json': /gates\.gates\[0\]\.cmd: ожидается строка/,
  'gates.invalid.gate-required.json': /gates\.gates\[0\]\.required: ожидается boolean/,
  'gates.invalid.gate-status.json': /gates\.gates\[0\]\.status: ожидается одно из pass\|fail/,
  'gates.invalid.gate-exit.json': /gates\.gates\[0\]\.exit: ожидается целое число/,
  'gates.invalid.gate-duration.json': /gates\.gates\[0\]\.duration_s: ожидается число ≥ 0/,
  'gates.invalid.gate-reason.json': /gates\.gates\[0\]\.reason: ожидается одна из причин/,
  'gates.invalid.gate-exit-missing.json': /gates\.gates\[1\]\.exit: обязательное поле/,
};

/** Нарушения `review.<n>.md`: по одному на файл. */
const REVIEW_INVALID = {
  'review.invalid.verdict.json': /review\.verdict: ожидается одно из merge-ready\|needs-changes/,
  'review.invalid.severity.json': /review\.findings\[0\]\.severity: ожидается одно из BLOCKER/,
  'review.invalid.summary.json': /review\.findings\[0\]\.summary: пустая строка недопустима/,
  'review.invalid.in-scope.json': /review\.findings\[0\]\.in_scope: ожидается boolean/,
  'review.invalid.preexisting.json': /review\.findings\[0\]\.preexisting: обязательное поле/,
  'review.invalid.line.json': /review\.findings\[1\]\.line: ожидается целое число/,
  'review.invalid.repro.json': /review\.findings\[1\]\.repro: пустая строка недопустима/,
};

/** Нарушения `evaluation.<n>.md`: по одному на файл. */
const EVALUATION_INVALID = {
  'evaluation.invalid.verdict.json': /evaluation\.verdict: ожидается одно из ACCEPT/,
  'evaluation.invalid.criterion-id.json':
    /evaluation\.criteria\[0\]\.id: значение не соответствует/,
  'evaluation.invalid.criterion-status.json':
    /evaluation\.criteria\[0\]\.status: ожидается одно из met/,
  'evaluation.invalid.criterion-evidence.json':
    /evaluation\.criteria\[0\]\.evidence: ожидается массив/,
  'evaluation.invalid.criterion-note.json': /evaluation\.criteria\[0\]\.note: ожидается строка/,
  'evaluation.invalid.score-range.json': /evaluation\.scores\.coverage: ожидается целое ≤ 3/,
  'evaluation.invalid.score-type.json': /evaluation\.scores\.correctness: ожидается целое число/,
  'evaluation.invalid.score-missing.json': /evaluation\.scores\.evidence: обязательное поле/,
  'evaluation.invalid.defect-severity.json':
    /evaluation\.defects\[0\]\.severity: ожидается одно из BLOCKER/,
  'evaluation.invalid.defect-claim.json':
    /evaluation\.defects\[0\]\.claim: пустая строка недопустима/,
  'evaluation.invalid.unverified-how.json':
    /evaluation\.unverified\[0\]\.how_to_verify: обязательное поле/,
};

/** Нарушения `qa-web.json`: по одному на файл. */
const QA_WEB_INVALID = {
  'qa-web.invalid.status.json': /qa-web\.status: ожидается одно из done\|not_run/,
  'qa-web.invalid.reason-missing.json': /qa-web\.reason: обязательное поле отсутствует/,
  'qa-web.invalid.step-id.json': /qa-web\.steps\[0\]\.id: значение не соответствует шаблону/,
  'qa-web.invalid.step-url.json': /qa-web\.steps\[0\]\.url: пустая строка недопустима/,
  'qa-web.invalid.step-observed.json': /qa-web\.steps\[0\]\.observed: ожидается строка/,
  'qa-web.invalid.step-console-errors.json': /qa-web\.steps\[0\]\.console_errors: ожидается массив/,
  'qa-web.invalid.step-failed-requests.json': /qa-web\.steps\[0\]\.failed_requests\[0\]/,
  'qa-web.invalid.step-cache-headers.json': /qa-web\.steps\[0\]\.cache_headers: ожидается строка/,
  'qa-web.invalid.step-cache-headers-missing.json':
    /qa-web\.steps\[1\]\.cache_headers: обязательное поле/,
};

/** Нарушения `decision.<n>.json`: по одному на файл. */
const DECISION_INVALID = {
  'decision.invalid.iteration.json': /decision\.iteration: ожидается целое ≥ 1/,
  'decision.invalid.action.json': /decision\.action: ожидается одно из REWORK/,
  'decision.invalid.retry-stage.json': /decision\.retry_stage: ожидается одно из REVIEW\|EVALUATE/,
  'decision.invalid.acquire.json': /decision\.acquire: обязательное поле отсутствует/,
  'decision.invalid.reasons-item.json': /decision\.reasons\[0\]: ожидается строка/,
  'decision.invalid.reasons-empty.json': /decision\.reasons\[1\]: пустая строка недопустима/,
  'decision.invalid.counts.json': /decision\.counts\.blockers: ожидается целое ≥ 0/,
  'decision.invalid.unresolved-refs.json': /decision\.unresolved_refs: ожидается целое ≥ 0/,
};

/**
 * `metrics.json` живёт в подкаталоге: это артефакт завершённого цикла, а не схема
 * отдельного этапа (issue #160, T8). Пути — от `scripts/fixtures/cycle/`.
 */
const METRICS_INVALID = {
  'metrics/metrics.invalid.tokens.json': /metrics\.tokens: ожидается объект этапов или null/,
  'metrics/metrics.invalid.cost-rub.json': /metrics\.cost_rub: ожидается число ≥ 0, получено -1/,
  'metrics/metrics.invalid.usage-stage.json':
    /metrics\.tokens\.gates: неизвестный этап \(ожидается plan\|code\|review\|evaluate\)/,
  'metrics/metrics.invalid.stage-duration.json':
    /metrics\.stage_durations_s\.PLAN: ожидается число ≥ 0, получено -1/,
  'metrics/metrics.invalid.unknown-stage.json':
    /metrics\.stage_durations_s: неизвестный этап "FINAL"/,
  'metrics/metrics.invalid.gate-outcomes.json':
    /metrics\.gate_outcomes\.lint\.not_run: обязательное поле отсутствует/,
  'metrics/metrics.invalid.only-review.json': /metrics\.only_review: ожидается целое ≥ 0/,
  'metrics/metrics.invalid.final-stage.json': /metrics\.final_stage: ожидается одно из INIT/,
  'metrics/metrics.invalid.family.json':
    /metrics\.evaluator_shares_family_with_plan: ожидается boolean/,
};

/** Нарушения `escalation.json`: по одному на файл. */
const ESCALATION_INVALID = {
  'escalation.invalid.reason.json': /escalation\.reason: ожидается одно из criteria_missing/,
  'escalation.invalid.detail.json': /escalation\.detail: ожидается строка/,
  'escalation.invalid.draft-pr.json': /escalation\.draft_pr_allowed: ожидается boolean/,
  'escalation.invalid.open-items.json': /escalation\.open_items: ожидается массив/,
};

describe('validateState', () => {
  test('валидный документ проходит', () => {
    assert.deepEqual(validateState(fixture('state.valid.json')), { ok: true, errors: [] });
  });

  // Каждый файл — отдельный тест: одна фикстура, одно нарушение Приложения A.
  checkInvalidFixtures(validateState, STATE_INVALID);

  test('невозможные дата и время ISO-8601 отвергаются', () => {
    const doc = fixture('state.valid.json');

    for (const value of ['2026-99-99T99:99:99Z', '2026-02-30T09:00:00Z']) {
      assertSingleError(
        validateState({ ...doc, updated_at: value }),
        /state\.updated_at: невозможные дата или время ISO-8601/,
      );
    }
  });

  test('значение с зоной смещения остаётся допустимым', () => {
    const doc = { ...fixture('state.valid.json'), updated_at: '2026-11-16T09:06:00+03:00' };

    assert.deepEqual(validateState(doc), { ok: true, errors: [] });
  });

  test('iteration > max_iterations допустим при owner_approved', () => {
    const doc = { ...fixture('state.valid.json'), iteration: 3, owner_approved: true };

    assert.deepEqual(validateState(doc), { ok: true, errors: [] });
  });

  test('iteration > max_iterations без owner_approved — ошибка', () => {
    const doc = { ...fixture('state.valid.json'), iteration: 3 };

    assertInvalidWith(
      validateState(doc),
      /state\.iteration: 3 > max_iterations 2 без owner_approved/,
    );
  });

  test('лишние поля игнорируются', () => {
    const doc = { ...fixture('state.valid.json'), future_field: { anything: [1, 2] } };

    assert.deepEqual(validateState(doc), { ok: true, errors: [] });
  });

  test('не объект — ошибка', () => {
    assertInvalidWith(validateState([1, 2, 3]), /state: ожидается объект, получено массив/);
    assertInvalidWith(validateState(null), /state: ожидается объект, получено null/);
  });

  test('эскалация в state проверяется по словарю D7', () => {
    const doc = {
      ...fixture('state.valid.json'),
      escalation: { reason: 'budget', detail: 'лимит токенов', draft_pr_allowed: false },
    };

    assert.deepEqual(validateState(doc), { ok: true, errors: [] });
  });
});

describe('validateGates', () => {
  test('валидный документ проходит', () => {
    assert.deepEqual(validateGates(fixture('gates.valid.json')), { ok: true, errors: [] });
  });

  // Каждый файл — отдельный тест: одна фикстура, одно нарушение Приложения A.
  checkInvalidFixtures(validateGates, GATES_INVALID);

  test('unknown и skipped-статусы и зависящий гейт допустимы', () => {
    const doc = {
      ...fixture('gates.valid.json'),
      gates: [
        {
          id: 'lint_workflows',
          cmd: 'pnpm lint:workflows',
          required: true,
          status: 'skipped',
          exit: null,
          duration_s: 0,
          log: null,
          reason: 'not_applicable',
        },
        {
          id: 'test',
          cmd: 'pnpm test',
          required: true,
          status: 'not_run',
          exit: null,
          duration_s: 0,
          log: null,
          reason: 'blocked_by:lint_workflows',
        },
      ],
    };

    assert.deepEqual(validateGates(doc), { ok: true, errors: [] });
  });
});

describe('validateReview', () => {
  test('валидный документ проходит', () => {
    assert.deepEqual(validateReview(fixture('review.valid.json')), { ok: true, errors: [] });
  });

  // Каждый файл — отдельный тест: одна фикстура, одно нарушение Приложения A.
  checkInvalidFixtures(validateReview, REVIEW_INVALID);

  test('блокер с пустыми file/line/repro недопустим', () => {
    const doc = {
      verdict: 'needs-changes',
      findings: [
        {
          id: 'R1',
          severity: 'BLOCKER',
          file: '',
          line: null,
          summary: 'Утечка телефона в лог',
          repro: '',
          in_scope: true,
          preexisting: false,
        },
      ],
    };
    const result = validateReview(doc);

    assertInvalidWith(result, /review\.findings\[0\]\.file: пустая строка недопустима/);
    assertInvalidWith(result, /review\.findings\[0\]\.repro: пустая строка недопустима/);
  });

  test('лишние поля находки игнорируются', () => {
    const doc = {
      verdict: 'merge-ready',
      findings: [
        {
          id: 'R1',
          severity: 'MINOR',
          file: '',
          line: '',
          summary: 'Замечание без места',
          repro: '',
          in_scope: true,
          preexisting: false,
          future_field: true,
        },
      ],
    };

    assert.deepEqual(validateReview(doc), { ok: true, errors: [] });
  });
});

describe('validateEvaluation', () => {
  test('валидный документ проходит', () => {
    assert.deepEqual(validateEvaluation(fixture('evaluation.valid.json')), {
      ok: true,
      errors: [],
    });
  });

  // Каждый файл — отдельный тест: одна фикстура, одно нарушение Приложения A.
  checkInvalidFixtures(validateEvaluation, EVALUATION_INVALID);

  test('оценка 0–3 и null допустимы', () => {
    const doc = fixture('evaluation.valid.json');
    doc.scores.coverage = 0;

    assert.deepEqual(validateEvaluation(doc), { ok: true, errors: [] });
  });
});

describe('validateQaWeb', () => {
  test('валидный документ проходит', () => {
    assert.deepEqual(validateQaWeb(fixture('qa-web.valid.json')), { ok: true, errors: [] });
  });

  // Каждый файл — отдельный тест: одна фикстура, одно нарушение Приложения A.
  checkInvalidFixtures(validateQaWeb, QA_WEB_INVALID);

  test('not_run с причиной допустим', () => {
    const doc = { status: 'not_run', reason: 'MCP playwright недоступен', steps: [] };

    assert.deepEqual(validateQaWeb(doc), { ok: true, errors: [] });
  });
});

describe('validateDecision', () => {
  test('валидный документ проходит', () => {
    assert.deepEqual(validateDecision(fixture('decision.valid.json')), { ok: true, errors: [] });
  });

  // Каждый файл — отдельный тест: одна фикстура, одно нарушение Приложения A.
  checkInvalidFixtures(validateDecision, DECISION_INVALID);

  test('RETRY_STAGE требует retry_stage', () => {
    const doc = { ...fixture('decision.valid.json'), action: 'RETRY_STAGE', retry_stage: null };

    assertInvalidWith(
      validateDecision(doc),
      /decision\.retry_stage: обязателен при action = RETRY_STAGE/,
    );

    assert.deepEqual(validateDecision({ ...doc, retry_stage: 'EVALUATE' }), {
      ok: true,
      errors: [],
    });
  });
});

describe('validateMetrics', () => {
  test('валидный документ проходит', () => {
    assert.deepEqual(validateMetrics(fixture('metrics/metrics.valid.json')), {
      ok: true,
      errors: [],
    });
  });

  // Каждый файл — отдельный тест: одна фикстура, одно нарушение Приложения A.
  checkInvalidFixtures(validateMetrics, METRICS_INVALID);

  test('tokens и cost_rub в фазе 1 строго null, а не отсутствуют', () => {
    const doc = fixture('metrics/metrics.valid.json');
    delete doc.tokens;

    assertSingleError(validateMetrics(doc), /metrics\.tokens: обязательное поле отсутствует/);
  });

  test('отрицательный исход гейта недопустим', () => {
    const doc = fixture('metrics/metrics.valid.json');
    doc.gate_outcomes.lint.pass = -1;

    assertSingleError(
      validateMetrics(doc),
      /metrics\.gate_outcomes\.lint\.pass: ожидается целое ≥ 0/,
    );
  });

  test('лишние поля и лишние ключи счётчиков игнорируются', () => {
    const doc = fixture('metrics/metrics.valid.json');
    doc.future_field = { anything: [1, 2] };
    doc.review_findings.EXTRA = 0;

    assert.deepEqual(validateMetrics(doc), { ok: true, errors: [] });
  });

  test('cycle_duration_s равен сумме stage_durations_s', () => {
    const doc = fixture('metrics/metrics.valid.json');
    doc.cycle_duration_s = 6749;

    assertSingleError(
      validateMetrics(doc),
      /metrics\.cycle_duration_s: не равен сумме stage_durations_s \(6749 ≠ 6750\)/,
    );
  });

  test('gate_total_s равен сумме gate_durations_s', () => {
    const doc = fixture('metrics/metrics.valid.json');
    doc.gate_total_s = 244.35;

    assertSingleError(
      validateMetrics(doc),
      /metrics\.gate_total_s: не равен сумме gate_durations_s \(244\.35 ≠ 245\.35\)/,
    );
  });

  test('равенство проверяется с допуском на плавающую точку', () => {
    const doc = fixture('metrics/metrics.valid.json');
    doc.cycle_duration_s = 6750.0000005;

    assert.deepEqual(validateMetrics(doc), { ok: true, errors: [] });
  });

  test('битая карта длительностей: одна внятная ошибка без расхождения с итогом', () => {
    for (const [value, pattern] of [
      [[], /metrics\.stage_durations_s: ожидается объект, получено массив/],
      [null, /metrics\.stage_durations_s: ожидается объект, получено null/],
      [42, /metrics\.stage_durations_s: ожидается объект, получено 42/],
    ]) {
      const doc = { ...fixture('metrics/metrics.valid.json'), stage_durations_s: value };
      assertSingleError(validateMetrics(doc), pattern);
    }

    const negativeStage = fixture('metrics/metrics.valid.json');
    negativeStage.stage_durations_s.PLAN = -1;
    assertSingleError(
      validateMetrics(negativeStage),
      /metrics\.stage_durations_s\.PLAN: ожидается число ≥ 0, получено -1/,
    );

    const negativeGate = fixture('metrics/metrics.valid.json');
    negativeGate.gate_durations_s.lint = -1;
    assertSingleError(
      validateMetrics(negativeGate),
      /metrics\.gate_durations_s\.lint: ожидается число ≥ 0, получено -1/,
    );
  });

  test('не объект — ошибка', () => {
    assertInvalidWith(validateMetrics([]), /metrics: ожидается объект, получено массив/);
    assertInvalidWith(validateMetrics(null), /metrics: ожидается объект, получено null/);
  });
});

describe('validateEscalation', () => {
  test('валидный документ проходит', () => {
    assert.deepEqual(validateEscalation(fixture('escalation.valid.json')), {
      ok: true,
      errors: [],
    });
  });

  // Каждый файл — отдельный тест: одна фикстура, одно нарушение Приложения A.
  checkInvalidFixtures(validateEscalation, ESCALATION_INVALID);

  test('detail может быть null', () => {
    const doc = fixture('escalation.valid.json');
    doc.detail = null;

    assert.deepEqual(validateEscalation(doc), { ok: true, errors: [] });
  });
});
