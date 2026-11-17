import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import { USAGE_STAGES, addStageUsage, parseArgs } from './cycle-usage.mjs';

const SCRIPT = resolve(import.meta.dirname, 'cycle-usage.mjs');

/** Запись транскрипта: ответ ассистента с текстом и usage. */
function assistant(usage) {
  return JSON.stringify({
    recordType: 'message',
    role: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ответ' }], usage },
  });
}

/**
 * Дерево-фикстура: каталог цикла внутри `.pi/artifacts` плюс транскрипт рядом.
 * @returns {{ root: string, cycleDir: string, transcript: string }}
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cycle-usage-'));
  const cycleDir = join(root, '.pi', 'artifacts', '2026-01-02-99-demo');
  mkdirSync(cycleDir, { recursive: true });
  writeFileSync(join(cycleDir, 'state.json'), JSON.stringify({ stage: 'CODE' }));

  const transcript = join(root, 'run_transcript.jsonl');
  writeFileSync(
    transcript,
    `${assistant({ input: 100, cacheRead: 900, cacheWrite: 0, output: 50, reasoning: 20 })}\n`,
  );

  return { root, cycleDir, transcript };
}

/**
 * Запуск CLI.
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: /** @type {{ status?: number }} */ (error).status ?? -1,
      stdout: String(/** @type {{ stdout?: unknown }} */ (error).stdout ?? ''),
      stderr: String(/** @type {{ stderr?: unknown }} */ (error).stderr ?? ''),
    };
  }
}

describe('addStageUsage', () => {
  test('первый прогон этапа создаёт запись, второй складывается с ней', () => {
    const one = addStageUsage(null, 'code', {
      input: 10,
      cache_read: 20,
      cache_write: 0,
      output: 30,
      reasoning: 5,
    });
    assert.deepEqual(one.code, {
      input: 10,
      cache_read: 20,
      cache_write: 0,
      output: 30,
      reasoning: 5,
      runs: 1,
    });

    const two = addStageUsage(one, 'code', {
      input: 1,
      cache_read: 2,
      cache_write: 0,
      output: 3,
      reasoning: 0,
    });
    assert.deepEqual(two.code, {
      input: 11,
      cache_read: 22,
      cache_write: 0,
      output: 33,
      reasoning: 5,
      runs: 2,
    });
    // Прежняя карта не меняется: функция чистая.
    assert.equal(one.code.runs, 1);
  });

  test('этапы не смешиваются', () => {
    const usage = addStageUsage(null, 'plan', {
      input: 1,
      cache_read: 0,
      cache_write: 0,
      output: 1,
      reasoning: 0,
    });
    assert.deepEqual(Object.keys(usage), ['plan']);
  });

  test('этап вне списка — исключение', () => {
    assert.throws(
      () =>
        addStageUsage(null, 'gates', {
          input: 1,
          cache_read: 0,
          cache_write: 0,
          output: 1,
          reasoning: 0,
        }),
      /этап gates/u,
    );
    assert.deepEqual([...USAGE_STAGES], ['plan', 'code', 'review', 'evaluate']);
  });
});

describe('parseArgs', () => {
  test('требует значения и отвергает мусор', () => {
    assert.throws(() => parseArgs(['--stage']), /--stage: ожидается значение/u);
    assert.throws(() => parseArgs(['--nope', 'x']), /неизвестный аргумент/u);
    assert.deepEqual(parseArgs(['--dir', 'a', '--stage', 'plan', '--transcript', 'b']), {
      dir: 'a',
      stage: 'plan',
      transcript: 'b',
      root: null,
    });
  });
});

describe('CLI: cycle-usage', () => {
  test('пишет usage.json по этапу и складывает повторные прогоны', () => {
    const { root, cycleDir, transcript } = fixture();
    const args = ['--root', root, '--dir', cycleDir, '--stage', 'code', '--transcript', transcript];

    assert.equal(run(args).status, 0);
    assert.equal(run(args).status, 0);

    const usage = JSON.parse(readFileSync(join(cycleDir, 'usage.json'), 'utf8'));
    assert.deepEqual(usage.code, {
      input: 200,
      cache_read: 1800,
      cache_write: 0,
      output: 100,
      reasoning: 40,
      runs: 2,
    });
  });

  test('два этапа живут в одном файле', () => {
    const { root, cycleDir, transcript } = fixture();
    for (const stage of ['plan', 'review']) {
      const result = run([
        '--root',
        root,
        '--dir',
        cycleDir,
        '--stage',
        stage,
        '--transcript',
        transcript,
      ]);
      assert.equal(result.status, 0, result.stderr);
    }
    const usage = JSON.parse(readFileSync(join(cycleDir, 'usage.json'), 'utf8'));
    assert.deepEqual(Object.keys(usage).sort(), ['plan', 'review']);
  });

  test('каталог без state.json и путь вне .pi/artifacts отклоняются', () => {
    const { root, cycleDir, transcript } = fixture();
    mkdirSync(join(root, '.pi', 'artifacts', 'empty'), { recursive: true });
    const noState = run([
      '--root',
      root,
      '--dir',
      join(root, '.pi', 'artifacts', 'empty'),
      '--stage',
      'plan',
      '--transcript',
      transcript,
    ]);
    assert.equal(noState.status, 2);
    assert.match(noState.stderr, /state\.json/u);

    const outside = run([
      '--root',
      root,
      '--dir',
      root,
      '--stage',
      'plan',
      '--transcript',
      transcript,
    ]);
    assert.equal(outside.status, 2);
    assert.match(outside.stderr, /внутри/u);
    assert.ok(cycleDir.length > 0);
  });

  test('этап вне review|plan|code|evaluate отклоняется', () => {
    const { root, cycleDir, transcript } = fixture();
    const result = run([
      '--root',
      root,
      '--dir',
      cycleDir,
      '--stage',
      'GATES',
      '--transcript',
      transcript,
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--stage: ожидается/u);
  });
});

describe('связка с cycle-metrics', () => {
  test('usage.json, записанный cycle-usage, читается метриками', () => {
    // Фикстура метрик копируется целиком: метрики ждут state.json и gates.<n>.json.
    const root = mkdtempSync(join(tmpdir(), 'cycle-usage-metrics-'));
    cpSync(
      join(import.meta.dirname, 'fixtures', 'cycle', 'metrics', 'full-cycle'),
      join(root, 'cycle'),
      {
        recursive: true,
      },
    );
    const cycleDir = join(root, 'cycle');
    // Модели — из снапшота цен: иначе стоимость законно останется null.
    const state = JSON.parse(readFileSync(join(cycleDir, 'state.json'), 'utf8'));
    state.models = {
      plan: 'z-ai/glm-5.3',
      code: 'deepseek/deepseek-v4.1-flash',
      review: 'openai/gpt-6-luna-pro',
      evaluate: 'z-ai/glm-5.3',
    };
    writeFileSync(join(cycleDir, 'state.json'), JSON.stringify(state, null, 2));

    writeFileSync(
      join(cycleDir, 'usage.json'),
      JSON.stringify({
        plan: { runs: 1, input: 1_000_000, cache_read: 0, cache_write: 0, output: 0, reasoning: 0 },
      }),
    );

    const metricsScript = resolve(import.meta.dirname, 'cycle-metrics.mjs');
    const result = execFileSync(process.execPath, [metricsScript, '--dir', cycleDir], {
      encoding: 'utf8',
      cwd: resolve(import.meta.dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const metrics = JSON.parse(result);
    assert.equal(metrics.tokens.plan.input, 1_000_000);
    // 1M входа glm-5.3 по цене снапшота — стоимость не null, а конкретное число.
    assert.equal(typeof metrics.cost_rub, 'number');
    assert.ok(metrics.cost_rub > 0, String(metrics.cost_rub));
  });
});
