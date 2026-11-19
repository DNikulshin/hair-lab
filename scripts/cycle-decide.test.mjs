import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { decide, diffTouchesWeb, normalizeDoc } from './cycle-decide.mjs';
import { validateDecision } from './lib/cycle/validate.mjs';

/** Путь к CLI: тесты запускают его как отдельный процесс. */
const SCRIPT = fileURLToPath(new URL('./cycle-decide.mjs', import.meta.url));

/** Корень фикстур схем: `scripts/fixtures/cycle/`. */
const FIXTURES = new URL('./fixtures/cycle/', import.meta.url);

/** Счётчики решения без элементов: база для ожиданий в тестах. */
const ZERO_COUNTS = Object.freeze({
  blockers: 0,
  major: 0,
  minor: 0,
  followups: 0,
  partial_criteria: 0,
  verdict_without_evidence: 0,
});

/** Sha базы: валидаторы требуют 40 hex, git в тестах не используется. */
const BASE_SHA = '0123456789abcdef0123456789abcdef01234567';

/**
 * Ожидаемые счётчики: нули, перекрытые явными значениями.
 * @param {Record<string, number>} [overrides]
 * @returns {Record<string, number>}
 */
function counts(overrides = {}) {
  return { ...ZERO_COUNTS, ...overrides };
}

/**
 * Разобранная фикстура схемы.
 * @param {string} name имя файла в `scripts/fixtures/cycle/`
 * @returns {any}
 */
function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
}

/**
 * Временный «репозиторий» для разрешения `path:line`: файл `src/app.mjs` на 12 строк.
 * @param {import('node:test').TestContext} t
 * @returns {string} корень
 */
function makeWorkspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'hair-lab-decide-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.mjs'), writeLines(12));
  return root;
}

/**
 * Содержимое файла на `count` строк с завершающим переводом строки.
 * @param {number} count
 * @returns {string}
 */
function writeLines(count) {
  return `${Array.from({ length: count }, (_, index) => `строка ${index + 1}`).join('\n')}\n`;
}

/**
 * Запись гейта в форме `gates.<n>.json`.
 * @param {string} id
 * @param {'pass'|'fail'|'skipped'|'not_run'} status
 * @param {{ required?: boolean, reason?: string|null }} [options]
 * @returns {Record<string, unknown>}
 */
function gate(id, status, { required = true, reason = null } = {}) {
  return {
    id,
    cmd: `pnpm ${id}`,
    required,
    status,
    exit: status === 'pass' ? 0 : null,
    duration_s: 1,
    log: null,
    reason,
  };
}

/**
 * Документ `gates.<n>.json`.
 * @param {Record<string, unknown>[]} entries
 * @returns {Record<string, unknown>}
 */
function gatesDoc(entries) {
  return {
    iteration: 1,
    base_sha: BASE_SHA,
    head: 'HEAD',
    started_at: '2026-11-16T09:10:00Z',
    gates: entries,
  };
}

/**
 * Документ ревью (блок ```json).
 * @param {Record<string, unknown>[]} [findings]
 * @param {'merge-ready'|'needs-changes'} [verdict]
 * @returns {Record<string, unknown>}
 */
function reviewDoc(findings = [], verdict = 'merge-ready') {
  return { verdict, findings };
}

/**
 * Документ независимой оценки (блок ```json).
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function evaluationDoc(overrides = {}) {
  return {
    verdict: 'ACCEPT',
    criteria: [],
    scores: {
      coverage: 3,
      correctness: 3,
      tests: 3,
      data: 3,
      pii_security: 3,
      architecture: 3,
      scope: 3,
      docs: 3,
      evidence: null,
    },
    defects: [],
    unverified: [],
    ...overrides,
  };
}

/**
 * Находка ревью, валидная как BLOCKER: файл и строка существуют в тестовом дереве.
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function finding(overrides = {}) {
  return {
    id: 'R1',
    severity: 'BLOCKER',
    file: 'src/app.mjs',
    line: 3,
    summary: 'Ссылка на несуществующую строку принимается',
    repro: "resolveRef('src/app.mjs:99') возвращает ok: true",
    in_scope: true,
    preexisting: false,
    ...overrides,
  };
}

/**
 * Критерий оценки.
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function criterion(overrides = {}) {
  return { id: 'C1', status: 'met', evidence: ['src/app.mjs:3'], note: 'выполнено', ...overrides };
}

/**
 * Дефект оценщика.
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function defect(overrides = {}) {
  return {
    id: 'D1',
    severity: 'BLOCKER',
    claim: 'Потеря строк при маскировании ломает номера строк',
    evidence: ['src/app.mjs:3'],
    repro: 'redactLog("a\\nb") возвращает одну строку',
    ...overrides,
  };
}

/**
 * Входы `decide` в «всё зелёное» состоянии.
 * @param {string} root корень тестового дерева
 * @param {Record<string, unknown>} [overrides]
 * @returns {any}
 */
function inputs(root, overrides = {}) {
  return {
    iteration: 1,
    maxIterations: 2,
    retries: { REVIEW: 0, EVALUATE: 0, evidence: 0 },
    gates: gatesDoc([gate('typecheck', 'pass')]),
    review: reviewDoc(),
    evaluation: evaluationDoc(),
    qaWeb: null,
    webDiff: false,
    root,
    ...overrides,
  };
}

/**
 * Счётчики повторов состояния.
 * @param {Partial<{ REVIEW: number, EVALUATE: number, evidence: number }>} [overrides]
 * @returns {{ REVIEW: number, EVALUATE: number, evidence: number }}
 */
function retries(overrides = {}) {
  return { REVIEW: 0, EVALUATE: 0, evidence: 0, ...overrides };
}

describe('diffTouchesWeb', () => {
  test('видит файлы приложения и сам каталог', () => {
    assert.equal(diffTouchesWeb(['apps/web']), true);
    assert.equal(diffTouchesWeb(['apps/web/app/page.tsx']), true);
  });

  test('не путает соседние каталоги с похожим префиксом', () => {
    assert.equal(diffTouchesWeb(['apps/web-admin/page.tsx']), false);
    assert.equal(diffTouchesWeb(['apps/api/src/main.ts']), false);
    assert.equal(diffTouchesWeb([]), false);
  });
});

describe('decide: правило 1 — невалидный вывод агента', () => {
  test('нет блока ревью → RETRY_STAGE(REVIEW)', (t) => {
    const result = decide(inputs(makeWorkspace(t), { review: null }));

    assert.equal(result.action, 'RETRY_STAGE');
    assert.equal(result.retry_stage, 'REVIEW');
    assert.deepEqual(result.reasons, ['retry:REVIEW agent_output_invalid']);
    assert.deepEqual(result.counts, counts());
    assert.deepEqual(result.rework_items, []);
    assert.equal(result.unresolved_refs, 0);
  });

  test('повторный отказ ревью → ESCALATE(agent_output_invalid)', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), { review: null, retries: retries({ REVIEW: 1 }) }),
    );

    assert.equal(result.action, 'ESCALATE');
    assert.equal(result.retry_stage, null);
    assert.deepEqual(result.reasons, ['escalate:agent_output_invalid']);
  });

  test('REVIEW проверяется раньше EVALUATE', (t) => {
    const result = decide(inputs(makeWorkspace(t), { review: null, evaluation: null }));

    assert.equal(result.retry_stage, 'REVIEW');
  });

  test('невалидная оценка → RETRY_STAGE(EVALUATE), повтор → ESCALATE', (t) => {
    const root = makeWorkspace(t);
    const first = decide(inputs(root, { evaluation: null }));
    assert.equal(first.action, 'RETRY_STAGE');
    assert.equal(first.retry_stage, 'EVALUATE');
    assert.deepEqual(first.reasons, ['retry:EVALUATE agent_output_invalid']);

    const second = decide(inputs(root, { evaluation: null, retries: retries({ EVALUATE: 1 }) }));
    assert.equal(second.action, 'ESCALATE');
    assert.deepEqual(second.reasons, ['escalate:agent_output_invalid']);
  });
});

describe('decide: правило 2a — гейты', () => {
  test('required-гейт fail блокирует и даёт REWORK', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        gates: gatesDoc([gate('typecheck', 'fail')]),
      }),
    );

    assert.equal(result.action, 'REWORK');
    assert.deepEqual(result.reasons, ['gate:typecheck: fail']);
    assert.deepEqual(result.rework_items, [
      'gate:typecheck [fail] — обязательный гейт не прошёл; лог: gates/typecheck.1.log',
    ]);
    // Провалившиеся гейты входят в reasons, но не в counts (уточнение супервизора, п. 2).
    assert.deepEqual(result.counts, counts());
  });

  test('fail необязательного гейта не блокирует', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        gates: gatesDoc([gate('lint_workflows', 'fail', { required: false })]),
      }),
    );

    assert.equal(result.action, 'PROCEED');
    assert.deepEqual(result.reasons, []);
  });

  test('fail на последней итерации → ESCALATE(iteration_limit)', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        iteration: 2,
        gates: gatesDoc([gate('typecheck', 'fail')]),
      }),
    );

    assert.equal(result.action, 'ESCALATE');
    assert.deepEqual(result.reasons, ['gate:typecheck: fail', 'escalate:iteration_limit']);
  });
});

describe('decide: правило 2b — находки ревью', () => {
  test('валидный BLOCKER блокирует', (t) => {
    const result = decide(inputs(makeWorkspace(t), { review: reviewDoc([finding()]) }));

    assert.equal(result.action, 'REWORK');
    assert.deepEqual(result.reasons, ['review:BLOCKER R1']);
    assert.deepEqual(result.counts, counts({ blockers: 1 }));
    assert.deepEqual(result.rework_items, [
      'R1 [BLOCKER] src/app.mjs:3 — Ссылка на несуществующую строку принимается; ' +
        "сценарий: resolveRef('src/app.mjs:99') возвращает ok: true",
    ]);
    assert.equal(result.unresolved_refs, 0);
  });

  test('валидный MAJOR в скоупе блокирует', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        review: reviewDoc([finding({ severity: 'MAJOR' })]),
      }),
    );

    assert.equal(result.action, 'REWORK');
    assert.deepEqual(result.reasons, ['review:MAJOR R1']);
    assert.deepEqual(result.counts, counts({ major: 1 }));
  });

  const DOWNGRADES = [
    {
      name: 'preexisting находка',
      finding: finding({ preexisting: true }),
      expected: 'R1 [BLOCKER] найдено до правок (preexisting)',
    },
    {
      name: 'MAJOR вне скоупа',
      finding: finding({ severity: 'MAJOR', in_scope: false }),
      expected: 'R1 [MAJOR] вне скоупа',
    },
    {
      name: 'нет сценария воспроизведения',
      finding: finding({ repro: '' }),
      expected: 'R1 [BLOCKER] нет сценария воспроизведения',
    },
    {
      name: 'нет пути и строки',
      finding: finding({ file: '', line: null }),
      expected: 'R1 [BLOCKER] нет пути и строки',
    },
    {
      name: 'неразрешаемая ссылка на файл',
      finding: finding({ file: 'src/missing.mjs' }),
      expected: 'R1 [BLOCKER] ссылка не разрешается',
    },
    {
      name: 'строка за концом файла',
      finding: finding({ line: 99 }),
      expected: 'R1 [BLOCKER] ссылка не разрешается',
    },
  ];

  for (const scenario of DOWNGRADES) {
    test(`${scenario.name}: понижается, не блокирует`, (t) => {
      const result = decide(inputs(makeWorkspace(t), { review: reviewDoc([scenario.finding]) }));

      assert.equal(result.action, 'PROCEED');
      assert.deepEqual(result.downgraded, [scenario.expected]);
      assert.deepEqual(result.counts, counts({ followups: 1 }));
      assert.deepEqual(result.rework_items, []);
    });
  }

  test('неразрешаемая ссылка увеличивает unresolved_refs', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        review: reviewDoc([finding({ file: 'src/missing.mjs' })]),
      }),
    );

    assert.equal(result.unresolved_refs, 1);
  });

  test('MINOR и FOLLOW-UP не блокируют, но попадают в counts', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        review: reviewDoc([
          finding({ id: 'R2', severity: 'MINOR', repro: '' }),
          finding({ id: 'R3', severity: 'FOLLOW-UP', file: '', line: null, repro: '' }),
        ]),
      }),
    );

    assert.equal(result.action, 'PROCEED');
    assert.deepEqual(result.counts, counts({ minor: 1, followups: 1 }));
    assert.deepEqual(result.downgraded, []);
  });

  test('битая ссылка у MINOR считается в unresolved_refs, но не блокирует', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        review: reviewDoc([finding({ severity: 'MINOR', file: 'src/missing.mjs' })]),
      }),
    );

    assert.equal(result.action, 'PROCEED');
    assert.equal(result.unresolved_refs, 1);
    assert.deepEqual(result.downgraded, []);
  });
});

describe('decide: правило 2c — критерии и дефекты оценки', () => {
  test('критерий unmet со свидетельством блокирует', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        evaluation: evaluationDoc({
          criteria: [criterion({ status: 'unmet', note: 'Нет теста на лимит' })],
        }),
      }),
    );

    assert.equal(result.action, 'REWORK');
    assert.deepEqual(result.reasons, ['criteria:C1 unmet']);
    assert.deepEqual(result.counts, counts({ blockers: 1 }));
    assert.deepEqual(result.rework_items, [
      'C1 [unmet] — Нет теста на лимит; свидетельства: src/app.mjs:3',
    ]);
  });

  test('критерий unmet без разрешаемой ссылки понижается', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        evaluation: evaluationDoc({
          criteria: [criterion({ status: 'unmet', evidence: ['src/missing.mjs:1'] })],
        }),
      }),
    );

    assert.equal(result.action, 'PROCEED');
    assert.deepEqual(result.downgraded, ['C1 [unmet] нет свидетельства']);
    assert.deepEqual(result.counts, counts({ followups: 1 }));
    assert.equal(result.unresolved_refs, 1);
  });

  test('дефект BLOCKER с repro и свидетельством блокирует', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), { evaluation: evaluationDoc({ defects: [defect()] }) }),
    );

    assert.equal(result.action, 'REWORK');
    assert.deepEqual(result.reasons, ['evaluation:BLOCKER D1']);
    assert.deepEqual(result.counts, counts({ blockers: 1 }));
    assert.deepEqual(result.rework_items, [
      'D1 [BLOCKER] src/app.mjs:3 — Потеря строк при маскировании ломает номера строк; ' +
        'сценарий: redactLog("a\\nb") возвращает одну строку',
    ]);
  });

  test('дефект без repro понижается', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        evaluation: evaluationDoc({ defects: [defect({ severity: 'MAJOR', repro: '' })] }),
      }),
    );

    assert.equal(result.action, 'PROCEED');
    assert.deepEqual(result.downgraded, ['D1 [MAJOR] нет сценария воспроизведения']);
  });

  test('дефект без разрешаемой ссылки понижается', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        evaluation: evaluationDoc({ defects: [defect({ evidence: ['src/missing.mjs:1'] })] }),
      }),
    );

    assert.equal(result.action, 'PROCEED');
    assert.deepEqual(result.downgraded, ['D1 [BLOCKER] нет свидетельства']);
    assert.equal(result.unresolved_refs, 1);
  });

  test('дефект MINOR не блокирует', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        evaluation: evaluationDoc({ defects: [defect({ severity: 'MINOR' })] }),
      }),
    );

    assert.equal(result.action, 'PROCEED');
    assert.deepEqual(result.counts, counts({ minor: 1 }));
  });

  test('ссылки на gate и qa разрешаются только при наличии артефактов', (t) => {
    const root = makeWorkspace(t);
    const gates = gatesDoc([gate('test_scripts', 'pass')]);
    const valid = decide(
      inputs(root, {
        gates,
        evaluation: evaluationDoc({
          criteria: [criterion({ status: 'unmet', evidence: ['gate:test_scripts'] })],
        }),
      }),
    );
    assert.equal(valid.action, 'REWORK');

    const unresolved = decide(
      inputs(root, {
        gates,
        evaluation: evaluationDoc({
          criteria: [criterion({ status: 'unmet', evidence: ['qa:s1'] })],
        }),
      }),
    );
    assert.deepEqual(unresolved.downgraded, ['C1 [unmet] нет свидетельства']);
    assert.equal(unresolved.unresolved_refs, 1);
  });
});

describe('decide: partial и вердикт без свидетельств', () => {
  test('критерий partial не блокирует и считается отдельно', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        evaluation: evaluationDoc({ criteria: [criterion({ status: 'partial' })] }),
      }),
    );

    assert.equal(result.action, 'PROCEED');
    assert.deepEqual(result.reasons, ['criteria:C1 partial']);
    assert.deepEqual(result.counts, counts({ partial_criteria: 1 }));
    assert.deepEqual(result.downgraded, []);
  });

  test('вердикт REWORK без валидных блокеров не блокирует', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        evaluation: evaluationDoc({ verdict: 'REWORK' }),
      }),
    );

    assert.equal(result.action, 'PROCEED');
    assert.deepEqual(result.counts, counts({ verdict_without_evidence: 1 }));
  });

  test('вердикт REWORK при валидном блокере не считается «без свидетельств»', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        review: reviewDoc([finding()]),
        evaluation: evaluationDoc({ verdict: 'REWORK' }),
      }),
    );

    assert.equal(result.action, 'REWORK');
    assert.deepEqual(result.counts, counts({ blockers: 1 }));
  });
});

describe('decide: правило 3 — лимит итераций', () => {
  test('блокер и iteration < max_iterations → REWORK', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        iteration: 1,
        maxIterations: 2,
        review: reviewDoc([finding()]),
      }),
    );

    assert.equal(result.action, 'REWORK');
  });

  test('блокер на лимите → ESCALATE(iteration_limit)', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        iteration: 2,
        maxIterations: 2,
        review: reviewDoc([finding()]),
      }),
    );

    assert.equal(result.action, 'ESCALATE');
    assert.deepEqual(result.reasons, ['review:BLOCKER R1', 'escalate:iteration_limit']);
  });
});

describe('decide: правило 4 — unverified и acquire', () => {
  const CASES = [
    {
      name: 'required-гейт not_run (timeout) добирается',
      setup: { gates: gatesDoc([gate('test_int', 'not_run', { reason: 'timeout' })]) },
      expected: {
        action: 'ACQUIRE_EVIDENCE',
        unverified: ['gate:test_int not_run (timeout)'],
        acquire: ['gate:test_int'],
      },
    },
    {
      name: 'повторный добор невозможен: retries.evidence ≥ 1',
      setup: {
        gates: gatesDoc([gate('test_int', 'not_run', { reason: 'timeout' })]),
        retries: retries({ evidence: 1 }),
      },
      expected: {
        action: 'PROCEED_WITH_UNVERIFIED',
        unverified: ['gate:test_int not_run (timeout)'],
        acquire: ['gate:test_int'],
      },
    },
    {
      name: 'no_database не добирается (T9)',
      setup: { gates: gatesDoc([gate('test_int', 'not_run', { reason: 'no_database' })]) },
      expected: {
        action: 'PROCEED_WITH_UNVERIFIED',
        unverified: ['gate:test_int not_run (no_database)'],
        acquire: [],
      },
    },
    {
      name: 'not_run без причины',
      setup: { gates: gatesDoc([gate('check_arch', 'not_run')]) },
      expected: {
        action: 'ACQUIRE_EVIDENCE',
        unverified: ['gate:check_arch not_run'],
        acquire: ['gate:check_arch'],
      },
    },
    {
      name: 'skipped и необязательные not_run не считаются непроверенными',
      setup: {
        gates: gatesDoc([
          gate('lint_workflows', 'skipped', { reason: 'not_applicable' }),
          gate('test_int', 'not_run', { required: false, reason: 'timeout' }),
        ]),
      },
      expected: { action: 'PROCEED', unverified: [], acquire: [] },
    },
    {
      name: 'web-дифф без qa-web → нужна браузерная проверка',
      setup: { webDiff: true },
      expected: {
        action: 'ACQUIRE_EVIDENCE',
        unverified: ['qa-web not_run (web-diff)'],
        acquire: ['qa-web'],
      },
    },
    {
      name: 'qa-web not_run с причиной',
      setup: {
        webDiff: true,
        qaWeb: { status: 'not_run', reason: 'нет стенда', steps: [] },
      },
      expected: {
        action: 'ACQUIRE_EVIDENCE',
        unverified: ['qa-web not_run (нет стенда)'],
        acquire: ['qa-web'],
      },
    },
    {
      name: 'qa-web done при web-диффе закрывает проверку',
      setup: { webDiff: true, qaWeb: { status: 'done', reason: null, steps: [] } },
      expected: { action: 'PROCEED', unverified: [], acquire: [] },
    },
    {
      name: 'qa-web не нужна без web-диффа',
      setup: { webDiff: false, qaWeb: { status: 'not_run', reason: 'нет стенда', steps: [] } },
      expected: { action: 'PROCEED', unverified: [], acquire: [] },
    },
    {
      name: 'критерий unverified не добирается гейтом',
      setup: {
        evaluation: evaluationDoc({ criteria: [criterion({ status: 'unverified' })] }),
      },
      expected: {
        action: 'PROCEED_WITH_UNVERIFIED',
        unverified: ['criteria:C1 unverified'],
        acquire: [],
      },
    },
    {
      name: 'unverified оценщика попадает в решение',
      setup: {
        evaluation: evaluationDoc({
          unverified: [
            { what: 'Поведение на битом JSON', why: 'нет фикстуры', how_to_verify: 'тест' },
          ],
        }),
      },
      expected: {
        action: 'PROCEED_WITH_UNVERIFIED',
        unverified: ['evaluation unverified: Поведение на битом JSON'],
        acquire: [],
      },
    },
    {
      name: 'порядок источников unverified фиксирован',
      setup: {
        webDiff: true,
        gates: gatesDoc([gate('test_int', 'not_run', { reason: 'no_database' })]),
        evaluation: evaluationDoc({
          criteria: [criterion({ id: 'C2', status: 'unverified' })],
          unverified: [{ what: 'Ручной сценарий', why: 'нет стенда', how_to_verify: 'qa' }],
        }),
      },
      expected: {
        action: 'ACQUIRE_EVIDENCE',
        unverified: [
          'gate:test_int not_run (no_database)',
          'qa-web not_run (web-diff)',
          'criteria:C2 unverified',
          'evaluation unverified: Ручной сценарий',
        ],
        acquire: ['qa-web'],
      },
    },
  ];

  for (const scenario of CASES) {
    test(scenario.name, (t) => {
      const result = decide(inputs(makeWorkspace(t), scenario.setup));

      assert.equal(result.action, scenario.expected.action);
      assert.deepEqual(result.unverified, scenario.expected.unverified);
      assert.deepEqual(result.acquire, scenario.expected.acquire);
    });
  }

  test('ACQUIRE_EVIDENCE не более одного раза за цикл', (t) => {
    const root = makeWorkspace(t);
    const setup = { gates: gatesDoc([gate('test_int', 'not_run', { reason: 'timeout' })]) };

    assert.equal(decide(inputs(root, setup)).action, 'ACQUIRE_EVIDENCE');
    assert.equal(
      decide(inputs(root, { ...setup, retries: retries({ evidence: 1 }) })).action,
      'PROCEED_WITH_UNVERIFIED',
    );
  });
});

describe('decide: правило 5 — PROCEED', () => {
  test('всё проверено и блокеров нет', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        evaluation: evaluationDoc({ criteria: [criterion()] }),
      }),
    );

    assert.equal(result.action, 'PROCEED');
    assert.equal(result.retry_stage, null);
    assert.deepEqual(result.acquire, []);
    assert.deepEqual(result.reasons, []);
    assert.deepEqual(result.rework_items, []);
    assert.deepEqual(result.unverified, []);
    assert.deepEqual(result.downgraded, []);
    assert.deepEqual(result.counts, counts());
    assert.equal(result.unresolved_refs, 0);
  });
});

describe('decide: правило 7 — бюджетный порог (§5.6, §11)', () => {
  test('costRub выше порога — ESCALATE с причиной budget', (t) => {
    const result = decide(inputs(makeWorkspace(t), { costRub: 50.01 }));

    assert.equal(result.action, 'ESCALATE');
    assert.equal(result.retry_stage, null);

    assert.deepEqual(result.reasons, [
      'budget: 50.01 ₽ > 50 ₽ (правило 7 §5.6, лимит: дефолт ядра)',
      'escalate:budget',
    ]);
    assert.equal(validateDecision(result).ok, true, validateDecision(result).errors.join('\n'));
  });

  test('ровно порог и ниже — обычное решение: сравнение строгое', (t) => {
    const root = makeWorkspace(t);

    for (const costRub of [50, 49.99, 0]) {
      const result = decide(inputs(root, { costRub }));
      assert.equal(result.action, 'PROCEED', `costRub = ${costRub}`);
      assert.deepEqual(result.reasons, []);
    }
  });

  test('без замера порог не применяется: null — это «неизвестно», а не ноль', (t) => {
    const root = makeWorkspace(t);

    for (const costRub of [null, undefined]) {
      const result = decide(inputs(root, { costRub }));
      assert.equal(result.action, 'PROCEED', `costRub = ${costRub}`);
    }
  });

  test('порог останавливает цикл раньше доработки: блокер не даёт REWORK', (t) => {
    const root = makeWorkspace(t);
    const result = decide(
      inputs(root, {
        gates: gatesDoc([gate('typecheck', 'fail')]),
        costRub: 55,
      }),
    );

    assert.equal(result.action, 'ESCALATE', 'жёсткий порог важнее правила 2');
    assert.ok(result.reasons.includes('escalate:budget'));
  });
});

describe('decide: маскирование свободного текста из вывода агентов (§5.4)', () => {
  /** JWT, который обязан превратиться в `[secret]`. */
  const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';

  test('summary и repro находки ревью маскируются, ссылка file:line и reasons целы', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        review: reviewDoc([
          finding({
            summary: 'Клиент +7 (999) 000-00-00 и user@example.com попадают в ответ',
            repro: `токен ${TOKEN} утекает в лог`,
          }),
        ]),
      }),
    );

    assert.equal(result.action, 'REWORK');
    // В reasons[] свободного текста нет: только серьёзность и id.
    assert.deepEqual(result.reasons, ['review:BLOCKER R1']);
    assert.deepEqual(result.rework_items, [
      'R1 [BLOCKER] src/app.mjs:3 — Клиент [phone] и [email] попадают в ответ; ' +
        'сценарий: токен [secret] утекает в лог',
    ]);
  });

  test('note критерия маскируется, свидетельства-ссылки остаются как есть', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        evaluation: evaluationDoc({
          criteria: [criterion({ status: 'unmet', note: 'Нет теста: письмо на user@example.com' })],
        }),
      }),
    );

    assert.deepEqual(result.rework_items, [
      'C1 [unmet] — Нет теста: письмо на [email]; свидетельства: src/app.mjs:3',
    ]);
  });

  test('claim и repro дефекта оценщика маскируются', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        evaluation: evaluationDoc({
          defects: [
            defect({
              claim: 'Телефон 8 (999) 000-00-00 уходит в ответ /api/me',
              repro: 'запрос с phone=+7 (999) 000-00-00 возвращает номер',
            }),
          ],
        }),
      }),
    );

    assert.deepEqual(result.rework_items, [
      'D1 [BLOCKER] src/app.mjs:3 — Телефон [phone] уходит в ответ /api/me; ' +
        'сценарий: запрос с phone=[phone] возвращает номер',
    ]);
  });

  test('unverified[].what маскируется', (t) => {
    const result = decide(
      inputs(makeWorkspace(t), {
        evaluation: evaluationDoc({
          unverified: [
            {
              what: 'Письмо на user@example.com не проверено',
              why: 'нет стенда',
              how_to_verify: 'qa',
            },
          ],
        }),
      }),
    );

    assert.equal(result.action, 'PROCEED_WITH_UNVERIFIED');
    assert.deepEqual(result.unverified, ['evaluation unverified: Письмо на [email] не проверено']);
  });
});

describe('decide: ссылки на .env* не читаются (AGENTS.md)', () => {
  const ENV_FILES = ['.env.local', '.env.production', './.env', 'apps/api/.env.local'];

  for (const file of ENV_FILES) {
    test(`ссылка на ${file} неразрешима, файл не читается`, (t) => {
      const root = makeWorkspace(t);
      // Файл на 3 строки: если бы resolver его прочитал, ссылка на строку 2 разрешилась бы.
      writeRepoFile(root, file.replace(/^\.\//, ''), 3);

      const result = decide(inputs(root, { review: reviewDoc([finding({ file, line: 2 })]) }));

      assert.equal(result.action, 'PROCEED');
      assert.deepEqual(result.downgraded, ['R1 [BLOCKER] ссылка не разрешается']);
      assert.equal(result.unresolved_refs, 1);
      assert.deepEqual(result.rework_items, []);
      // Сам путь в решение не попадает.
      assert.equal(JSON.stringify(result).includes('.env'), false);
    });
  }

  test('.env.example разрешается как обычный файл', (t) => {
    const root = makeWorkspace(t);
    writeRepoFile(root, '.env.example', 3);

    const result = decide(
      inputs(root, { review: reviewDoc([finding({ file: '.env.example', line: 2 })]) }),
    );

    assert.equal(result.action, 'REWORK');
    assert.deepEqual(result.downgraded, []);
    assert.equal(result.unresolved_refs, 0);
    assert.match(result.rework_items[0], /^R1 \[BLOCKER\] \.env\.example:2 — /);
  });

  test('ссылка на .env в свидетельствах критерия не разрешается', (t) => {
    const root = makeWorkspace(t);
    writeRepoFile(root, '.env.local', 3);

    const result = decide(
      inputs(root, {
        evaluation: evaluationDoc({
          criteria: [criterion({ status: 'unmet', evidence: ['.env.local:2'] })],
        }),
      }),
    );

    assert.equal(result.action, 'PROCEED');
    assert.deepEqual(result.downgraded, ['C1 [unmet] нет свидетельства']);
    assert.equal(result.unresolved_refs, 1);
    assert.equal(JSON.stringify(result).includes('.env'), false);
  });
});

describe('decide: детерминизм', () => {
  test('два расчёта на одних входах совпадают и сериализуются одинаково', (t) => {
    const root = makeWorkspace(t);
    const setup = inputs(root, {
      gates: gatesDoc([gate('test_int', 'not_run', { reason: 'no_database' })]),
      review: reviewDoc([finding(), finding({ id: 'R2', severity: 'MINOR', repro: '' })]),
      evaluation: evaluationDoc({
        criteria: [criterion({ id: 'C1', status: 'partial' })],
        defects: [defect({ severity: 'MINOR' })],
      }),
    });

    const first = JSON.stringify(normalizeDoc(decide(setup)));
    const second = JSON.stringify(normalizeDoc(decide(setup)));
    assert.equal(first, second);
    assert.deepEqual(decide(setup), decide(setup));
  });

  test('порядок ключей во входных объектах не влияет на результат', () => {
    const reviewWithOrder = (fields) => ({
      verdict: 'merge-ready',
      findings: [fields],
    });
    // Тот же блокер, но ключи объявлены в обратном порядке.
    const normal = finding();
    const reversed = Object.fromEntries(Object.entries(normal).reverse());

    assert.deepEqual(
      JSON.stringify(normalizeDoc(reviewWithOrder(normal))),
      JSON.stringify(normalizeDoc(reviewWithOrder(reversed))),
    );
  });
});

/**
 * Выполняет git в каталоге и возвращает stdout; ошибка — падение теста.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function gitRun(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Временный git-репозиторий с одним коммитом: `base_sha` для диффа цикла.
 * @param {import('node:test').TestContext} t
 * @returns {{ root: string, baseSha: string }}
 */
function makeRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'hair-lab-decide-repo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  gitRun(root, ['init', '--quiet']);
  gitRun(root, ['config', 'user.email', 'test@example.com']);
  gitRun(root, ['config', 'user.name', 'Тестовый агент']);
  gitRun(root, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.mjs'), writeLines(5));
  gitRun(root, ['add', '-A']);
  gitRun(root, ['commit', '--quiet', '-m', 'база']);
  return { root, baseSha: gitRun(root, ['rev-parse', 'HEAD']) };
}

/**
 * Создаёт файл на `count` строк (свидетельства ссылаются на него).
 * @param {string} root
 * @param {string} relative
 * @param {number} count
 * @returns {void}
 */
function writeRepoFile(root, relative, count) {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, writeLines(count));
}

/**
 * Валидный `state.json` для тестового цикла.
 * @param {string} baseSha
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function stateDoc(baseSha, overrides = {}) {
  return {
    issue: 156,
    slug: 'cycle-decide',
    branch: 'chore/156-cycle-decide',
    base_sha: baseSha,
    iteration: 1,
    max_iterations: 2,
    stage: 'DECIDE',
    stage_status: 'running',
    criteria_source: 'issue',
    retries: retries(),
    owner_approved: false,
    models: { plan: 'vendor/plan', code: 'vendor/code', review: 'vendor/review' },
    history: [
      {
        stage: 'DECIDE',
        iteration: 1,
        started_at: '2026-11-16T09:00:00Z',
        finished_at: null,
        status: 'running',
      },
    ],
    escalation: null,
    started_at: '2026-11-16T09:00:00Z',
    updated_at: '2026-11-16T09:06:00Z',
    ...overrides,
  };
}

/**
 * Каталог цикла с артефактами; переданные параметры перекрывают умолчания.
 * @param {string} root корень тестового репозитория
 * @param {{ state?: unknown, gates?: unknown, reviewMd?: string, evaluationMd?: string, qaWeb?: unknown, iteration?: number }} [options]
 * @returns {string} каталог цикла
 */
function makeCycleDir(root, options = {}) {
  const { iteration = 1 } = options;
  const dir = join(root, '.pi', 'artifacts', '2026-11-16-156-cycle-decide');
  mkdirSync(dir, { recursive: true });

  const state = options.state ?? stateDoc(gitRun(root, ['rev-parse', 'HEAD']), { iteration });
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);

  if (options.gates !== null) {
    const gates = options.gates ?? gatesDoc([gate('typecheck', 'pass')]);
    writeFileSync(join(dir, `gates.${iteration}.json`), `${JSON.stringify(gates, null, 2)}\n`);
  }

  if (options.reviewMd !== undefined) {
    writeFileSync(join(dir, `review.${iteration}.md`), options.reviewMd);
  }
  if (options.evaluationMd !== undefined) {
    writeFileSync(join(dir, `evaluation.${iteration}.md`), options.evaluationMd);
  }
  if (options.qaWeb !== undefined) {
    writeFileSync(join(dir, 'qa-web.json'), `${JSON.stringify(options.qaWeb, null, 2)}\n`);
  }

  return dir;
}

/**
 * Markdown-вывод агента с заключительным блоком ```json.
 * @param {unknown} doc
 * @returns {string}
 */
function mdBlock(doc) {
  return [
    '# Отчёт',
    '',
    'Пояснение к выводу.',
    '',
    '```json',
    JSON.stringify(doc, null, 2),
    '```',
    '',
  ].join('\n');
}

/**
 * Запускает CLI как отдельный процесс.
 * @param {string} cwd
 * @param {string[]} [args]
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runCli(cwd, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

describe('CLI: запись решения', () => {
  test('пишет review/evaluation json из md-блоков и решение', (t) => {
    const repo = makeRepo(t);
    // Свидетельства фикстур ссылаются на реальные модули ядра цикла.
    writeRepoFile(repo.root, 'scripts/lib/cycle/refs.mjs', 200);
    writeRepoFile(repo.root, 'scripts/lib/cycle/redact.mjs', 100);
    writeRepoFile(repo.root, 'scripts/lib/cycle/validate.mjs', 10);

    const dir = makeCycleDir(repo.root, {
      gates: gatesDoc([gate('test_scripts', 'pass'), gate('test_int', 'pass')]),
      reviewMd: readFileSync(new URL('review.valid.md', FIXTURES), 'utf8'),
      evaluationMd: readFileSync(new URL('evaluation.valid.md', FIXTURES), 'utf8'),
    });

    const result = runCli(repo.root, ['--dir', dir]);

    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'в stdout должна быть одна строка JSON');

    const decision = JSON.parse(lines[0]);
    assert.deepEqual(validateDecision(decision), { ok: true, errors: [] });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'decision.1.json'), 'utf8')), decision);

    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, 'review.1.json'), 'utf8')),
      normalizeDoc(fixture('review.valid.json')),
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, 'evaluation.1.json'), 'utf8')),
      normalizeDoc(fixture('evaluation.valid.json')),
    );

    assert.equal(decision.action, 'REWORK');
    assert.deepEqual(
      decision.counts,
      counts({ blockers: 1, major: 1, minor: 2, followups: 1, partial_criteria: 1 }),
    );
    assert.deepEqual(decision.reasons, [
      'review:BLOCKER R1',
      'review:MAJOR R2',
      'criteria:C2 partial',
      'criteria:C3 unverified',
    ]);
    assert.equal(decision.unresolved_refs, 0);
  });

  test('без блока json в md — правило 1 и никаких review/evaluation json', (t) => {
    const repo = makeRepo(t);
    const evaluation = evaluationDoc();
    const dir = makeCycleDir(repo.root, {
      reviewMd: '# Ревью\n\nБлок ```json агент не добавил.\n',
      evaluationMd: mdBlock(evaluation),
    });

    const first = runCli(repo.root, ['--dir', dir]);
    assert.equal(first.status, 0, first.stderr);
    const decision = JSON.parse(first.stdout);
    assert.equal(decision.action, 'RETRY_STAGE');
    assert.equal(decision.retry_stage, 'REVIEW');
    assert.equal(existsSync(join(dir, 'review.1.json')), false);
    assert.equal(existsSync(join(dir, 'evaluation.1.json')), true);

    // Повторный невалидный вывод ревью — эскалация, а не второй повтор.
    writeFileSync(
      join(dir, 'state.json'),
      `${JSON.stringify(stateDoc(repo.baseSha, { retries: retries({ REVIEW: 1 }) }), null, 2)}\n`,
    );
    const second = runCli(repo.root, ['--dir', dir]);
    assert.equal(second.status, 0, second.stderr);
    const escalated = JSON.parse(second.stdout);
    assert.equal(escalated.action, 'ESCALATE');
    // #247: к причине добавлены пути полей из валидатора, полный список — в stderr.
    assert.deepEqual(escalated.reasons, [
      'escalate:agent_output_invalid',
      'invalid:REVIEW review.1.md: нет блока ```json или JSON не разбирается (в markdown нет размеченного блока ```json)',
    ]);
    assert.match(second.stderr, /cycle-decide: review\.1\.md: нет блока/);
  });

  test('битый JSON в блоке md — правило 1', (t) => {
    const repo = makeRepo(t);
    const dir = makeCycleDir(repo.root, {
      reviewMd: '# Ревью\n\n```json\n{"verdict": }\n```\n',
      evaluationMd: mdBlock(evaluationDoc()),
    });

    const result = runCli(repo.root, ['--dir', dir]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).action, 'RETRY_STAGE');
    assert.equal(existsSync(join(dir, 'review.1.json')), false);
  });

  test('невалидная схема называет поля: пути из валидатора в reasons и stderr (#247)', (t) => {
    const repo = makeRepo(t);
    const { scores: _scores, ...withoutScores } = evaluationDoc();
    const dir = makeCycleDir(repo.root, {
      reviewMd: mdBlock(reviewDoc()),
      evaluationMd: mdBlock(withoutScores),
    });

    const result = runCli(repo.root, ['--dir', dir]);

    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.action, 'RETRY_STAGE');
    assert.equal(decision.retry_stage, 'EVALUATE');
    assert.equal(decision.reasons[0], 'retry:EVALUATE agent_output_invalid');
    const details = decision.reasons.slice(1);
    assert.ok(details.length > 0, 'к причине добавлены пути полей');
    assert.ok(details.length <= 5, 'в решение попадает не больше пяти ошибок');
    assert.ok(
      details.every((item) => item.startsWith('invalid:EVALUATE evaluation.1.md: ') === true),
      'каждая подробность называет этап и файл',
    );
    assert.ok(
      details.some((item) => item.includes('evaluation.scores') === true),
      'видно, какого поля не хватило',
    );
    assert.match(result.stderr, /cycle-decide: evaluation\.1\.md: evaluation\.scores/);
    assert.equal(existsSync(join(dir, 'evaluation.1.json')), false);
  });

  test('последний блок md побеждает и перезаписывает прежний json', (t) => {
    const repo = makeRepo(t);
    const stale = { verdict: 'needs-changes', findings: [] };
    const dir = makeCycleDir(repo.root, {
      reviewMd: [
        '```json',
        '{"verdict":"needs-changes","findings":[]}',
        '```',
        '',
        '```json',
        '{"verdict":"merge-ready","findings":[]}',
        '```',
        '',
      ].join('\n'),
      evaluationMd: mdBlock(evaluationDoc()),
    });
    writeFileSync(join(dir, 'review.1.json'), `${JSON.stringify(stale)}\n`);

    const result = runCli(repo.root, ['--dir', dir]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      JSON.parse(readFileSync(join(dir, 'review.1.json'), 'utf8')).verdict,
      'merge-ready',
    );
  });

  test('решение детерминировано: два прогона дают одинаковые файлы', (t) => {
    const repo = makeRepo(t);
    const dir = makeCycleDir(repo.root, {
      gates: gatesDoc([gate('test_int', 'not_run', { reason: 'no_database' })]),
      reviewMd: mdBlock(reviewDoc([finding({ preexisting: true })])),
      evaluationMd: mdBlock(evaluationDoc({ criteria: [criterion({ status: 'partial' })] })),
    });

    assert.equal(runCli(repo.root, ['--dir', dir]).status, 0);
    const first = ['decision.1.json', 'review.1.json', 'evaluation.1.json'].map((name) =>
      readFileSync(join(dir, name), 'utf8'),
    );

    assert.equal(runCli(repo.root, ['--dir', dir]).status, 0);
    const second = ['decision.1.json', 'review.1.json', 'evaluation.1.json'].map((name) =>
      readFileSync(join(dir, name), 'utf8'),
    );

    assert.deepEqual(second, first);
  });

  test('--iteration выбирает артефакты другой итерации', (t) => {
    const repo = makeRepo(t);
    const dir = makeCycleDir(repo.root, {
      reviewMd: mdBlock(reviewDoc()),
      evaluationMd: mdBlock(evaluationDoc()),
    });
    writeFileSync(
      join(dir, 'gates.2.json'),
      `${JSON.stringify(gatesDoc([gate('typecheck', 'pass')]), null, 2)}\n`,
    );
    writeFileSync(join(dir, 'review.2.md'), mdBlock(reviewDoc()));
    writeFileSync(join(dir, 'evaluation.2.md'), mdBlock(evaluationDoc()));

    const result = runCli(repo.root, ['--dir', dir, '--iteration', '2']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, 'decision.2.json')), true);
    assert.equal(existsSync(join(dir, 'decision.1.json')), false);
    assert.equal(JSON.parse(readFileSync(join(dir, 'decision.2.json'), 'utf8')).iteration, 2);
  });

  test('без --dir берётся единственный активный цикл', (t) => {
    const repo = makeRepo(t);
    const dir = makeCycleDir(repo.root, {
      reviewMd: mdBlock(reviewDoc()),
      evaluationMd: mdBlock(evaluationDoc()),
    });
    const finished = join(repo.root, '.pi', 'artifacts', '2026-11-10-1-old');
    mkdirSync(finished, { recursive: true });
    writeFileSync(
      join(finished, 'state.json'),
      `${JSON.stringify(stateDoc(repo.baseSha, { stage: 'DONE' }), null, 2)}\n`,
    );

    const result = runCli(repo.root);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, 'decision.1.json')), true);
  });
});

describe('CLI: web-дифф и qa-web', () => {
  test('web-дифф виден только после intent-to-add', (t) => {
    const repo = makeRepo(t);
    const dir = makeCycleDir(repo.root, {
      reviewMd: mdBlock(reviewDoc()),
      evaluationMd: mdBlock(evaluationDoc()),
    });
    writeRepoFile(repo.root, 'apps/web/app/page.tsx', 3);

    const withoutIntent = runCli(repo.root, ['--dir', dir]);
    assert.equal(withoutIntent.status, 0, withoutIntent.stderr);
    assert.equal(JSON.parse(withoutIntent.stdout).action, 'PROCEED');

    gitRun(repo.root, ['add', '--intent-to-add', '--', 'apps/web/app/page.tsx']);

    const withIntent = runCli(repo.root, ['--dir', dir]);
    assert.equal(withIntent.status, 0, withIntent.stderr);
    const decision = JSON.parse(withIntent.stdout);
    assert.equal(decision.action, 'ACQUIRE_EVIDENCE');
    assert.deepEqual(decision.acquire, ['qa-web']);
    assert.deepEqual(decision.unverified, ['qa-web not_run (web-diff)']);
  });

  test('qa-web done при web-диффе даёт PROCEED', (t) => {
    const repo = makeRepo(t);
    writeRepoFile(repo.root, 'apps/web/app/page.tsx', 3);
    const dir = makeCycleDir(repo.root, {
      reviewMd: mdBlock(reviewDoc()),
      evaluationMd: mdBlock(evaluationDoc()),
      qaWeb: { status: 'done', reason: null, steps: [] },
    });

    const result = runCli(repo.root, ['--dir', dir]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).action, 'PROCEED');
  });

  test('битый qa-web.json — отказ (код 2)', (t) => {
    const repo = makeRepo(t);
    const dir = makeCycleDir(repo.root, {
      reviewMd: mdBlock(reviewDoc()),
      evaluationMd: mdBlock(evaluationDoc()),
    });
    writeFileSync(join(dir, 'qa-web.json'), '{ "status": }\n');

    const result = runCli(repo.root, ['--dir', dir]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /qa-web\.json/);
  });
});

describe('CLI: ПДн в решении и запрет чтения .env*', () => {
  test('телефон из summary не попадает в decision.<n>.json и stdout', (t) => {
    const repo = makeRepo(t);
    const dir = makeCycleDir(repo.root, {
      reviewMd: mdBlock(
        reviewDoc([
          finding({
            summary: 'Телефон клиента +7 (999) 000-00-00 печатается в ответе',
            repro: 'GET /api/me возвращает phone',
          }),
        ]),
      ),
      evaluationMd: mdBlock(evaluationDoc()),
    });

    const result = runCli(repo.root, ['--dir', dir]);

    assert.equal(result.status, 0, result.stderr);
    const written = readFileSync(join(dir, 'decision.1.json'), 'utf8');
    assert.equal(written.includes('999'), false);
    assert.equal(result.stdout.includes('999'), false);
    assert.match(written, /\[phone\]/);

    const decision = JSON.parse(written);
    assert.equal(decision.action, 'REWORK');
    assert.deepEqual(decision.rework_items, [
      'R1 [BLOCKER] src/app.mjs:3 — Телефон клиента [phone] печатается в ответе; ' +
        'сценарий: GET /api/me возвращает phone',
    ]);
  });

  test('ссылка на .env.local в md-ревью не читается и не попадает в решение', (t) => {
    const repo = makeRepo(t);
    writeRepoFile(repo.root, '.env.local', 3);
    const dir = makeCycleDir(repo.root, {
      reviewMd: mdBlock(reviewDoc([finding({ file: '.env.local', line: 2 })])),
      evaluationMd: mdBlock(evaluationDoc()),
    });

    const result = runCli(repo.root, ['--dir', dir]);

    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.action, 'PROCEED');
    assert.deepEqual(decision.downgraded, ['R1 [BLOCKER] ссылка не разрешается']);
    assert.equal(decision.unresolved_refs, 1);
    assert.equal(result.stdout.includes('.env'), false);
    assert.equal(readFileSync(join(dir, 'decision.1.json'), 'utf8').includes('.env'), false);
  });
});

describe('CLI: ошибки использования (код 2)', () => {
  test('нет state.json', (t) => {
    const repo = makeRepo(t);
    const dir = makeCycleDir(repo.root, {
      reviewMd: mdBlock(reviewDoc()),
      evaluationMd: mdBlock(evaluationDoc()),
    });
    rmSync(join(dir, 'state.json'));

    const result = runCli(repo.root, ['--dir', dir]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /state\.json/);
    assert.equal(existsSync(join(dir, 'decision.1.json')), false);
  });

  test('state.json с нарушенной схемой', (t) => {
    const repo = makeRepo(t);
    const dir = makeCycleDir(repo.root, {
      state: stateDoc(repo.baseSha, { stage: 'НЕВЕРНО' }),
      reviewMd: mdBlock(reviewDoc()),
      evaluationMd: mdBlock(evaluationDoc()),
    });

    const result = runCli(repo.root, ['--dir', dir]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /state\.json: схема нарушена/);
  });

  test('битый gates.<n>.json', (t) => {
    const repo = makeRepo(t);
    const dir = makeCycleDir(repo.root, {
      gates: { iteration: 1, gates: 'нет массива' },
      reviewMd: mdBlock(reviewDoc()),
      evaluationMd: mdBlock(evaluationDoc()),
    });

    const result = runCli(repo.root, ['--dir', dir]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /gates\.1\.json/);
  });

  test('отсутствующий gates.<n>.json', (t) => {
    const repo = makeRepo(t);
    const dir = makeCycleDir(repo.root, {
      gates: null,
      reviewMd: mdBlock(reviewDoc()),
      evaluationMd: mdBlock(evaluationDoc()),
    });

    const result = runCli(repo.root, ['--dir', dir]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /gates\.1\.json/);
    // Предпосылка DECIDE не выполнена: ни решение, ни нормализованные md не пишутся.
    for (const name of ['decision.1.json', 'review.1.json', 'evaluation.1.json']) {
      assert.equal(existsSync(join(dir, name)), false, name);
    }
  });

  test('мусор в аргументах', (t) => {
    const repo = makeRepo(t);

    for (const args of [['--iteration', 'abc'], ['--unknown'], ['--dir']]) {
      const result = runCli(repo.root, args);
      assert.equal(result.status, 2, `аргументы ${args.join(' ')}`);
      assert.notEqual(result.stderr, '');
    }
  });
});

describe('CLI: бюджет по usage.json (правило 7 §5.6)', () => {
  /** Снапшот цен: только модели тестового `state.json`, рубли за 1M токенов. */
  const PRICES = {
    _meta: { currency: 'RUB' },
    models: {
      'vendor/plan': { input: 100, output: 100, cache_read: 100, cache_write: 0, context: 1000 },
    },
  };

  /**
   * Кладёт `evals/prices.json` в тестовый репозиторий.
   * @param {string} root
   * @returns {void}
   */
  function writePrices(root) {
    mkdirSync(join(root, 'evals'), { recursive: true });
    writeFileSync(join(root, 'evals', 'prices.json'), `${JSON.stringify(PRICES, null, 2)}\n`);
  }

  test('расход выше порога — ESCALATE(budget), хотя блокеров нет', (t) => {
    const repo = makeRepo(t);
    writePrices(repo.root);

    const dir = makeCycleDir(repo.root, {
      gates: gatesDoc([gate('typecheck', 'pass')]),
      reviewMd: mdBlock(reviewDoc()),
      evaluationMd: mdBlock(evaluationDoc()),
    });
    // 1M входных токенов по 100 ₽ за 1M = 100 ₽ > 50 ₽ (§5.2, LIMITS.maxCycleCostRub).
    writeFileSync(
      join(dir, 'usage.json'),
      `${JSON.stringify({ plan: { runs: 1, input: 1_000_000 } }, null, 2)}\n`,
    );

    const result = runCli(repo.root, ['--dir', dir]);

    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(result.stdout.trim());
    assert.deepEqual(validateDecision(decision), { ok: true, errors: [] });
    assert.equal(decision.action, 'ESCALATE');
    assert.ok(decision.reasons.includes('escalate:budget'), decision.reasons.join(' | '));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'decision.1.json'), 'utf8')), decision);
  });

  test('без usage.json стоимость — null, решение идёт по общим правилам', (t) => {
    const repo = makeRepo(t);
    writePrices(repo.root);

    const dir = makeCycleDir(repo.root, {
      gates: gatesDoc([gate('typecheck', 'pass')]),
      reviewMd: mdBlock(reviewDoc()),
      evaluationMd: mdBlock(evaluationDoc()),
    });

    const result = runCli(repo.root, ['--dir', dir]);

    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(result.stdout.trim());
    assert.equal(decision.action, 'PROCEED', 'нет замера — нет повода эскалировать');
    assert.deepEqual(decision.reasons, []);
  });

  test('битый usage.json — код 2, а не тихий ноль в бюджете', (t) => {
    const repo = makeRepo(t);
    writePrices(repo.root);

    const dir = makeCycleDir(repo.root, {
      gates: gatesDoc([gate('typecheck', 'pass')]),
      reviewMd: mdBlock(reviewDoc()),
      evaluationMd: mdBlock(evaluationDoc()),
    });
    writeFileSync(join(dir, 'usage.json'), '{"plan": \n');

    const result = runCli(repo.root, ['--dir', dir]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage\.json: не читается/u);
    assert.equal(existsSync(join(dir, 'decision.1.json')), false);
  });
});
