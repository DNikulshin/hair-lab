import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

import { lastAssistantText, sumUsage } from './lib/evals/usage.mjs';

const SCRIPT = resolve(import.meta.dirname, 'evals-collect.mjs');

/** Запись транскрипта: ответ ассистента с текстом и usage. */
function assistant(text, usage) {
  return {
    recordType: 'message',
    role: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }], usage },
  };
}

describe('lastAssistantText', () => {
  test('берёт текст последнего ответа, а не весь диалог', () => {
    const records = [assistant('первый'), assistant('второй')];
    assert.equal(lastAssistantText(records), 'второй');
  });

  test('несколько текстовых частей склеиваются, вызовы инструментов не попадают', () => {
    const records = [
      {
        recordType: 'message',
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'часть 1' },
            { type: 'toolCall', name: 'read' },
            { type: 'text', text: 'часть 2' },
          ],
        },
      },
    ];
    assert.equal(lastAssistantText(records), 'часть 1\nчасть 2');
  });

  test('сообщения пользователя и системные записи игнорируются', () => {
    const records = [
      {
        recordType: 'message',
        role: 'user',
        message: { content: [{ type: 'text', text: 'нет' }] },
      },
      assistant('да'),
      { recordType: 'status', role: 'assistant' },
    ];
    assert.equal(lastAssistantText(records), 'да');
  });

  test('пустой транскрипт — пустая строка, а не падение', () => {
    assert.equal(lastAssistantText([]), '');
  });
});

describe('sumUsage', () => {
  test('суммирует токены всех запросов прогона', () => {
    const records = [
      assistant('a', { input: 10, cacheRead: 100, cacheWrite: 1, output: 20, reasoning: 5 }),
      assistant('b', { input: 5, cacheRead: 50, cacheWrite: 0, output: 7, reasoning: 0 }),
    ];
    assert.deepEqual(sumUsage(records), {
      input: 15,
      cache_read: 150,
      cache_write: 1,
      output: 27,
      reasoning: 5,
    });
  });

  test('записи без usage не ломают сумму', () => {
    const records = [{ recordType: 'message', role: 'assistant', message: { content: [] } }];
    assert.deepEqual(sumUsage(records), {
      input: 0,
      cache_read: 0,
      cache_write: 0,
      output: 0,
      reasoning: 0,
    });
  });
});

/**
 * Дерево-фикстура: прогон с meta.json и транскрипт рядом.
 * @returns {{ root: string, runDir: string, transcript: string }}
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'evals-collect-'));
  const runDir = join(root, '.pi', 'artifacts', 'evals', '2026-01-02-E5-current');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({ seed: 'E5', config: 'current' }));

  const transcript = join(root, 'run_review_transcript.jsonl');
  const lines = [
    JSON.stringify(assistant('черновик без блока')),
    JSON.stringify(
      assistant('итог\n```json\n{"verdict":"merge-ready","findings":[]}\n```', {
        input: 11,
        cacheRead: 22,
        cacheWrite: 0,
        output: 33,
        reasoning: 4,
      }),
    ),
    '{"recordType":"message","role":"assist',
  ];
  writeFileSync(transcript, `${lines.join('\n')}\n`);

  return { root, runDir, transcript };
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

describe('evals-collect CLI', () => {
  test('пишет полный ответ из транскрипта и usage по стадии', () => {
    const { root, runDir, transcript } = fixture();
    const result = run([
      '--root',
      root,
      '--run',
      runDir,
      '--stage',
      'review',
      '--transcript',
      transcript,
    ]);
    assert.equal(result.status, 0, result.stderr);

    const answer = readFileSync(join(runDir, 'review.md'), 'utf8');
    assert.match(answer, /```json/u);
    assert.match(answer, /merge-ready/u);

    const usage = JSON.parse(readFileSync(join(runDir, 'usage.json'), 'utf8'));
    assert.deepEqual(usage.review, {
      input: 11,
      cache_read: 22,
      cache_write: 0,
      output: 33,
      reasoning: 4,
      runs: 1,
    });
  });

  test('usage второй стадии дописывается, а не затирает первую', () => {
    const { root, runDir, transcript } = fixture();
    assert.equal(
      run(['--root', root, '--run', runDir, '--stage', 'review', '--transcript', transcript])
        .status,
      0,
    );
    assert.equal(
      run(['--root', root, '--run', runDir, '--stage', 'evaluate', '--transcript', transcript])
        .status,
      0,
    );

    const usage = JSON.parse(readFileSync(join(runDir, 'usage.json'), 'utf8'));
    assert.deepEqual(Object.keys(usage).sort(), ['evaluate', 'review']);
  });

  test('стадия вне review|evaluate и запись вне .pi/artifacts/evals отклоняются', () => {
    const { root, runDir, transcript } = fixture();
    assert.match(
      run(['--root', root, '--run', runDir, '--stage', 'code', '--transcript', transcript]).stderr,
      /--stage: ожидается/u,
    );
    assert.match(
      run(['--root', root, '--run', root, '--stage', 'review', '--transcript', transcript]).stderr,
      /внутри/u,
    );
  });

  test('каталог без meta.json — ошибка: прогон не собран', () => {
    const { root, transcript } = fixture();
    const empty = join(root, '.pi', 'artifacts', 'evals', 'empty');
    mkdirSync(empty, { recursive: true });
    const result = run([
      '--root',
      root,
      '--run',
      empty,
      '--stage',
      'review',
      '--transcript',
      transcript,
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /meta\.json/u);
  });
});
