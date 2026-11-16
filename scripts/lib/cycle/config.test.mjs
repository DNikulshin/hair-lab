import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { GATES, GATE_TIMEOUTS, LIMITS } from './config.mjs';

/** Нормативный порядок и состав гейтов §5.5. */
const EXPECTED_IDS = [
  'contracts_build',
  'typecheck',
  'lint',
  'check_arch',
  'lint_workflows',
  'test',
  'test_int',
  'test_scripts',
  'check_harness',
  'format_check',
  'secrets_scan',
];

describe('GATES', () => {
  test('порядок и состав id совпадают с §5.5', () => {
    assert.deepEqual(
      GATES.map((gate) => gate.id),
      EXPECTED_IDS,
    );
  });

  test('зависимости указывают на существующие гейты, объявленные раньше', () => {
    const seen = new Set();
    for (const gate of GATES) {
      for (const parent of gate.dependsOn) {
        assert.ok(seen.has(parent), `${gate.id}: неизвестная или поздняя зависимость ${parent}`);
      }
      seen.add(gate.id);
    }

    assert.deepEqual(
      GATES.filter((gate) => gate.dependsOn.length > 0).map((gate) => [gate.id, gate.dependsOn]),
      [
        ['typecheck', ['contracts_build']],
        ['test', ['contracts_build']],
        ['test_int', ['contracts_build']],
      ],
    );
  });

  test('все гейты обязательные, команда задана везде, кроме встроенного secrets_scan', () => {
    for (const gate of GATES) {
      assert.equal(gate.required, true, `${gate.id}: required`);
      if (gate.id === 'secrets_scan') {
        assert.equal(gate.cmd, null);
      } else {
        assert.equal(typeof gate.cmd, 'string');
        assert.ok(gate.cmd.startsWith('pnpm '), `${gate.id}: команда без оболочки через pnpm`);
      }
    }
  });

  test('условия запуска по путям совпадают с §5.5', () => {
    assert.deepEqual(
      GATES.filter((gate) => gate.pathPrefixes.length > 0).map((gate) => [
        gate.id,
        gate.pathPrefixes,
      ]),
      [
        ['lint_workflows', ['.github/workflows/']],
        ['test_int', ['apps/api/', 'packages/contracts/']],
        ['test_scripts', ['scripts/']],
        ['check_harness', ['.pi/', 'scripts/cycle-', 'AGENTS.md']],
      ],
    );
    // Остальные гейты выполняются всегда.
    assert.deepEqual(
      GATES.filter((gate) => gate.pathPrefixes.length === 0).map((gate) => gate.id),
      [
        'contracts_build',
        'typecheck',
        'lint',
        'check_arch',
        'test',
        'format_check',
        'secrets_scan',
      ],
    );
  });
});

describe('LIMITS', () => {
  test('лимиты §5.2 зафиксированы точно', () => {
    assert.deepEqual(LIMITS, {
      maxDiffLines: 2000,
      maxDiffBytes: 409_600,
      logMaxBytes: 5_242_880,
      evidenceTailLines: 200,
      defaultMaxIterations: 2,
    });
  });
});

describe('GATE_TIMEOUTS', () => {
  test('тайм-аут задан для каждого гейта и положителен', () => {
    assert.deepEqual(Object.keys(GATE_TIMEOUTS).sort(), [...EXPECTED_IDS].sort());
    for (const [id, timeout] of Object.entries(GATE_TIMEOUTS)) {
      assert.ok(Number.isInteger(timeout) && timeout > 0, `${id}: тайм-аут должен быть > 0 мс`);
    }
  });
});
