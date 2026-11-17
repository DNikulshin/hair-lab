#!/usr/bin/env node
/**
 * Сборка каталога прогона сида для живого A/B (docs/evals.md).
 *
 * Один прогон — один сид и одна конфигурация моделей. Каталог содержит:
 *
 * - `tree/` — синтетический git-репозиторий: базовое состояние закоммичено, правка
 *   сида лежит в рабочем дереве. Агенты работают в нём, поэтому видят и дифф, и файлы
 *   целиком — как в настоящем цикле;
 * - `evidence/diff.patch` — `git diff` этого дерева (с новыми файлами: перед диффом
 *   выполняется `git add -A --intent-to-add`, как в `cycle-evidence`, D5);
 * - `evidence/issue.md`, `evidence/criteria.md` — вход этапов по §7;
 * - `evidence/gates.json` — пустой список гейтов: на синтетическом дереве они не запускаются,
 *   и честнее сказать это явно, чем оставить файла не было (иначе агент читает отсутствие
 *   как нехватку свидетельств);
 * - `meta.json` — сид, конфигурация, модели, время сборки.
 *
 * `AGENTS.md` копируется в базовый коммит: правила проекта действуют и на синтетическом
 * дереве, иначе агент не смог бы сослаться на них, а дифф не должен их содержать.
 *
 * Пишет только внутрь `.pi/artifacts/evals/` и отказывается работать по другому пути.
 * Время берётся из `--now` или системных часов и попадает только в `meta.json`
 * и имя каталога: дифф и деревья от времени не зависят.
 *
 * Коды выхода: `0` — каталог собран; `2` — ошибка использования, данных или git.
 * Shebang нужен: файл запускается напрямую.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAgentModels } from './lib/evals/agents.mjs';
import { applyDelta, readCandidates } from './lib/evals/cost.mjs';
import { loadSeeds, seedCriteriaMarkdown, seedIssueMarkdown } from './lib/evals/seeds.mjs';
import { writeJsonAtomic } from './lib/cycle/io.mjs';
import { artifactsDir, repoRoot } from './lib/cycle/paths.mjs';
import { SCORED_STAGES } from './lib/evals/score.mjs';

/** Фиксированные даты коммита: sha базового коммита не должен зависеть от запуска. */
const FIXED_DATE = '2000-01-01T00:00:00Z';

/** Имя ветки базового коммита: не зависит от настроек git пользователя. */
const BRANCH = 'evals';

/**
 * Разбирает аргументы командной строки.
 * @param {string[]} argv
 * @returns {{ seed: string|null, config: string, out: string|null, now: string|null, force: boolean, root: string|null }}
 */
export function parseArgs(argv) {
  /** @type {{ seed: string|null, config: string, out: string|null, now: string|null, force: boolean, root: string|null }} */
  const args = { seed: null, config: 'current', out: null, now: null, force: false, root: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--force') {
      args.force = true;
      continue;
    }
    const key = arg.startsWith('--') ? arg.slice(2) : null;
    if (key === 'seed' || key === 'config' || key === 'out' || key === 'now' || key === 'root') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
        throw new Error(`${arg}: ожидается значение`);
      }
      args[key] = value.trim();
      index += 1;
      continue;
    }
    throw new Error(`неизвестный аргумент: ${arg}`);
  }

  return args;
}

/**
 * Запуск git без оболочки и с фиксированными датами: результат не зависит от окружения.
 * @param {string[]} args аргументы после `git`
 * @param {string} cwd рабочий каталог
 * @returns {string} stdout
 */
function git(args, cwd) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=evals',
      '-c',
      'user.email=evals@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE },
    },
  );
}

/**
 * Запись файла с созданием каталогов.
 * @param {string} file
 * @param {string} text
 * @returns {void}
 */
function writeFileDeep(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * Дата для имени каталога: `YYYY-MM-DD`.
 * @param {string} iso момент времени ISO-8601
 * @returns {string}
 */
export function datePart(iso) {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) throw new Error(`--now: не разбирается как дата ISO-8601`);
  return new Date(parsed).toISOString().slice(0, 10);
}

/**
 * Точка входа CLI.
 * @returns {void}
 */
function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.seed === null) throw new Error('--seed: обязателен (например, --seed E5)');

    const root = args.root === null ? repoRoot() : resolve(args.root);
    const seeds = loadSeeds(join(root, 'evals', 'orchestrator', 'seeds'));
    const seed = seeds.find((item) => item.id === args.seed);
    if (seed === undefined) {
      throw new Error(
        `сид ${args.seed} не найден; есть: ${seeds.map((item) => item.id).join(', ')}`,
      );
    }

    const current = readAgentModels(root);
    /** @type {Record<string, string>} */
    let models = current;
    if (args.config !== 'current') {
      const candidates = readCandidates(
        JSON.parse(readFileSync(join(root, 'evals', 'candidates.json'), 'utf8')),
      );
      const candidate = candidates[args.config];
      if (candidate === undefined) {
        throw new Error(
          `кандидат ${args.config} не найден; есть: current, ${Object.keys(candidates).join(', ')}`,
        );
      }
      models = applyDelta(current, candidate.models);
    }

    const now = args.now ?? new Date().toISOString();
    const evalsRoot = join(artifactsDir(root), 'evals');
    const runDir =
      args.out === null
        ? join(evalsRoot, `${datePart(now)}-${seed.id}-${args.config}`)
        : resolve(args.out);

    // Запись и удаление — только внутри каталога прогонов: сид не должен уметь
    // разложить файлы по репозиторию.
    if (!runDir.startsWith(`${evalsRoot}${sep}`)) {
      throw new Error(`каталог прогона должен быть внутри ${join('.pi', 'artifacts', 'evals')}`);
    }
    if (existsSync(runDir)) {
      if (!args.force) {
        throw new Error('каталог прогона уже существует; перезапись — с --force');
      }
      rmSync(runDir, { recursive: true, force: true });
    }

    const treeDir = join(runDir, 'tree');
    const evidenceDir = join(runDir, 'evidence');
    mkdirSync(treeDir, { recursive: true });

    for (const [path, text] of Object.entries(seed.base)) writeFileDeep(join(treeDir, path), text);

    const agentsMd = join(root, 'AGENTS.md');
    if (existsSync(agentsMd))
      writeFileDeep(join(treeDir, 'AGENTS.md'), readFileSync(agentsMd, 'utf8'));

    git(['init', '-q', '-b', BRANCH], treeDir);
    git(['add', '-A'], treeDir);
    git(['commit', '-q', '-m', 'base', '--no-verify'], treeDir);
    const baseSha = git(['rev-parse', 'HEAD'], treeDir).trim();

    for (const [path, text] of Object.entries(seed.after)) writeFileDeep(join(treeDir, path), text);
    for (const path of seed.deleted) rmSync(join(treeDir, path), { force: true });

    git(['add', '-A', '--intent-to-add'], treeDir);
    const patch = git(['diff'], treeDir);

    writeFileDeep(join(evidenceDir, 'issue.md'), seedIssueMarkdown(seed));
    writeFileDeep(join(evidenceDir, 'criteria.md'), seedCriteriaMarkdown(seed));
    writeFileDeep(join(evidenceDir, 'diff.patch'), patch);
    writeFileDeep(
      join(evidenceDir, 'gates.json'),
      `${JSON.stringify(
        { iteration: 1, base_sha: baseSha, head: BRANCH, started_at: now, gates: [] },
        null,
        2,
      )}\n`,
    );

    writeJsonAtomic(
      join(runDir, 'meta.json'),
      {
        seed: seed.id,
        config: args.config,
        models: Object.fromEntries(SCORED_STAGES.map((stage) => [stage, models[stage]])),
        stages: [...SCORED_STAGES],
        created_at: now,
        expect: seed.expect,
      },
      { serialize: (data) => `${JSON.stringify(data, null, 2)}\n` },
    );

    const diffLines = patch === '' ? 0 : patch.split('\n').length - 1;
    process.stdout.write(
      [
        `прогон: ${runDir}`,
        `  сид: ${seed.id} — ${seed.title}`,
        `  ожидание: ${seed.expect.kind === 'clean' ? 'чистый дифф, блокеров нет' : `${seed.expect.severity ?? 'BLOCKER'} в ${seed.expect.file ?? '?'}:${seed.expect.line ?? '?'}`}`,
        `  модели: ${SCORED_STAGES.map((stage) => `${stage}=${models[stage]}`).join(', ')}`,
        `  дифф: ${diffLines} строк`,
        '',
      ].join('\n'),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`evals-pack: ${message}\n`);
    process.exitCode = 2;
  }
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
