import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';

/** Путь к CLI относительно теста: тест не зависит от текущего каталога запуска. */
const SCRIPT = resolve(import.meta.dirname, 'evals-pack.mjs');

/** Агент harness: проверяется только `model`, остальное — минимальный валидный frontmatter. */
function agent(name, model) {
  return `---\nname: ${name}\ndescription: 'тест'\nmodel: polza-ai/${model}\nthinking: low\ntools: read\n---\n\nтекст\n`;
}

const SEED = {
  id: 'E5',
  title: 'Телефон в логе',
  why: 'ПДн в логах',
  expect: { kind: 'defect', severity: 'BLOCKER', file: 'apps/api/src/x.ts', line: 3 },
  issue: { title: 'issue', body: 'тело issue' },
  criteria: ['первый критерий', 'второй критерий'],
  base: { 'apps/api/src/x.ts': 'строка 1\nстрока 2\nlog(mask(phone));\n' },
  after: { 'apps/api/src/x.ts': 'строка 1\nстрока 2\nlog(phone);\n' },
};

/**
 * Дерево-фикстура: агенты, сид, кандидат, правила проекта.
 * @returns {string} корень фикстуры
 */
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'evals-pack-'));

  for (const [name, model] of [
    ['plan', 'z-ai/glm-5.3'],
    ['code', 'deepseek/deepseek-v4.1-flash'],
    ['review', 'openai/gpt-6-luna-pro'],
    ['evaluate', 'z-ai/glm-5.3'],
  ]) {
    mkdirSync(join(root, '.pi', 'agents'), { recursive: true });
    writeFileSync(join(root, '.pi', 'agents', `${name}.md`), agent(name, model));
  }

  mkdirSync(join(root, 'evals', 'orchestrator', 'seeds'), { recursive: true });
  writeFileSync(join(root, 'evals', 'orchestrator', 'seeds', 'E5.json'), JSON.stringify(SEED));
  writeFileSync(
    join(root, 'evals', 'candidates.json'),
    JSON.stringify({ candidates: { 'evaluate-flash': { evaluate: 'z-ai/glm-5.3-flash' } } }),
  );
  writeFileSync(join(root, 'AGENTS.md'), '# Правила проекта\n\nтекст правил\n');

  return root;
}

/**
 * Запуск CLI: код выхода и потоки вместо исключения.
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

describe('evals-pack', () => {
  test('собирает каталог прогона: дерево, дифф, свидетельства, meta', () => {
    const root = fixtureRoot();
    const result = run(['--root', root, '--seed', 'E5', '--now', '2026-01-02T03:04:05Z']);
    assert.equal(result.status, 0, result.stderr);

    const runDir = join(root, '.pi', 'artifacts', 'evals', '2026-01-02-E5-current');
    assert.ok(existsSync(runDir), 'каталог прогона');
    assert.match(result.stdout, /дифф: [1-9]\d* строк/u);

    const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8'));
    assert.equal(meta.seed, 'E5');
    assert.equal(meta.config, 'current');
    assert.deepEqual(meta.models, {
      evaluate: 'z-ai/glm-5.3',
      review: 'openai/gpt-6-luna-pro',
    });
    assert.equal(meta.created_at, '2026-01-02T03:04:05Z');

    const patch = readFileSync(join(runDir, 'evidence', 'diff.patch'), 'utf8');
    assert.match(patch, /^-log\(mask\(phone\)\);$/mu);
    assert.match(patch, /^\+log\(phone\);$/mu);
    assert.ok(!patch.includes('AGENTS.md'), 'правила проекта не должны попадать в дифф');

    // Строка дефекта в дереве «после» совпадает с ожиданием сида.
    const after = readFileSync(join(runDir, 'tree', 'apps', 'api', 'src', 'x.ts'), 'utf8');
    assert.equal(after.split('\n')[SEED.expect.line - 1], 'log(phone);');

    // Правила проекта есть в дереве: агент должен их видеть.
    assert.ok(existsSync(join(runDir, 'tree', 'AGENTS.md')));

    // Гейты на синтетическом дереве не запускаются — это сказано явно.
    const gates = JSON.parse(readFileSync(join(runDir, 'evidence', 'gates.json'), 'utf8'));
    assert.deepEqual(gates.gates, []);
    assert.match(gates.base_sha, /^[0-9a-f]{40}$/u);

    // Критерии пронумерованы: на них ссылается оценка.
    const criteria = readFileSync(join(runDir, 'evidence', 'criteria.md'), 'utf8');
    assert.match(criteria, /- C1 первый критерий/u);
    assert.match(criteria, /- C2 второй критерий/u);
  });

  test('кандидат подменяет модель стадии в meta', () => {
    const root = fixtureRoot();
    const result = run([
      '--root',
      root,
      '--seed',
      'E5',
      '--config',
      'evaluate-flash',
      '--now',
      '2026-01-02T03:04:05Z',
    ]);
    assert.equal(result.status, 0, result.stderr);

    const meta = JSON.parse(
      readFileSync(
        join(root, '.pi', 'artifacts', 'evals', '2026-01-02-E5-evaluate-flash', 'meta.json'),
        'utf8',
      ),
    );
    assert.equal(meta.models.evaluate, 'z-ai/glm-5.3-flash');
    assert.equal(meta.models.review, 'openai/gpt-6-luna-pro');
  });

  test('существующий каталог не перезаписывается без --force', () => {
    const root = fixtureRoot();
    assert.equal(run(['--root', root, '--seed', 'E5', '--now', '2026-01-02T00:00:00Z']).status, 0);

    const again = run(['--root', root, '--seed', 'E5', '--now', '2026-01-02T00:00:00Z']);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /уже существует/u);

    const forced = run([
      '--root',
      root,
      '--seed',
      'E5',
      '--now',
      '2026-01-02T00:00:00Z',
      '--force',
    ]);
    assert.equal(forced.status, 0, forced.stderr);
  });

  test('каталог вне .pi/artifacts/evals отклоняется', () => {
    const root = fixtureRoot();
    const result = run([
      '--root',
      root,
      '--seed',
      'E5',
      '--out',
      join(root, 'elsewhere'),
      '--now',
      '2026-01-02T00:00:00Z',
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /внутри/u);
    assert.ok(!existsSync(join(root, 'elsewhere')));
  });

  test('неизвестный сид и отсутствие --seed — ошибки использования', () => {
    const root = fixtureRoot();
    assert.match(run(['--root', root, '--seed', 'E99']).stderr, /не найден/u);
    assert.match(run(['--root', root]).stderr, /--seed: обязателен/u);
  });
});
