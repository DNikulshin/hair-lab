#!/usr/bin/env node
/**
 * Свод по прогонам сидов: полнота, ложные блокировки, стоимость (docs/evals.md).
 *
 * Вход — каталог прогонов (`.pi/artifacts/evals/<...>/`), собранный `evals-pack.mjs`
 * и заполненный ответами этапов:
 *
 * - `meta.json` — сид, конфигурация, модели, время (пишет `evals-pack`);
 * - `review.md` / `evaluate.md` — ответ агента целиком, с блоком ```json в конце
 *   (пишет супервизор: у этих агентов нет прав на запись файлов);
 * - `usage.json` — необязательные фактические токены по стадиям
 *   `{ "review": { "input": 42322, "cache_read": 562984, "output": 14352 } }`.
 *   Без него стоимость в отчёте `null`: выдумывать её из профилей нельзя, это уже не факт.
 *
 * Выход: `report.json` и `report.md` в том же каталоге, таблица в stdout.
 *
 * Пороги §15 — допущения, а не измеренная истина: вердикт `ok` значит «данные не
 * противоречат порогам», а `below_threshold` — повод посмотреть прогоны, а не приговор модели.
 *
 * Коды выхода: `0` — отчёт записан и пороги не нарушены; `1` — отчёт записан, пороги
 * нарушены; `2` — ошибка использования или данных.
 * Shebang нужен: файл запускается напрямую.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeDoc } from './cycle-decide.mjs';
import { priceStage, readPrices, roundRub } from './lib/evals/cost.mjs';
import { SCORED_STAGES, buildReport, scoreRun } from './lib/evals/score.mjs';
import { loadSeeds } from './lib/evals/seeds.mjs';
import { writeJsonAtomic, writeTextAtomic } from './lib/cycle/io.mjs';
import { artifactsDir, repoRoot } from './lib/cycle/paths.mjs';

/** Пороги по умолчанию (docs/orchestrator.md §15: полнота ≥ 0.8, ложные блокировки ≤ 1 из 5). */
export const DEFAULT_THRESHOLDS = Object.freeze({ completeness: 0.8, false_positive_max: 0.2 });

/**
 * Разбирает аргументы командной строки.
 * @param {string[]} argv
 * @returns {{ runs: string|null, seeds: string|null, prices: string|null, root: string|null, completeness: number, falsePositiveMax: number }}
 */
export function parseArgs(argv) {
  /** @type {{ runs: string|null, seeds: string|null, prices: string|null, root: string|null, completeness: number, falsePositiveMax: number }} */
  const args = {
    runs: null,
    seeds: null,
    prices: null,
    root: null,
    completeness: DEFAULT_THRESHOLDS.completeness,
    falsePositiveMax: DEFAULT_THRESHOLDS.false_positive_max,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const key = arg.startsWith('--') ? arg.slice(2) : null;
    if (key === 'runs' || key === 'seeds' || key === 'prices' || key === 'root') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
        throw new Error(`${arg}: ожидается путь`);
      }
      args[/** @type {'runs'|'seeds'|'prices'|'root'} */ (key)] = value.trim();
      index += 1;
      continue;
    }
    if (key === 'completeness' || key === 'fp-max') {
      const value = Number(argv[index + 1]);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`${arg}: ожидается число от 0 до 1`);
      }
      if (key === 'completeness') args.completeness = value;
      else args.falsePositiveMax = value;
      index += 1;
      continue;
    }
    throw new Error(`неизвестный аргумент: ${arg}`);
  }

  return args;
}

/**
 * JSON-файл с сообщением об имени файла, а не об абсолютном пути.
 * @param {string} file
 * @param {string} label
 * @returns {unknown}
 */
function readJsonFile(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const code = /** @type {{ code?: unknown } | undefined} */ (error)?.code;
    throw new Error(
      `${label}: ${typeof code === 'string' ? `не читается (${code})` : 'битый JSON'}`,
      { cause: error },
    );
  }
}

/**
 * Каталоги прогонов: подкаталоги с `meta.json`, упорядоченные по имени.
 * @param {string} dir
 * @returns {string[]}
 */
export function findRuns(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isDirectory() && existsSync(join(path, 'meta.json')));
}

/**
 * Точка входа CLI.
 * @returns {void}
 */
function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const root = args.root === null ? repoRoot() : resolve(args.root);
    const runsDir = args.runs === null ? join(artifactsDir(root), 'evals') : resolve(args.runs);
    const seeds = loadSeeds(args.seeds ?? join(root, 'evals', 'orchestrator', 'seeds'));
    const prices = readPrices(
      readJsonFile(args.prices ?? join(root, 'evals', 'prices.json'), 'evals/prices.json'),
    );

    /** @type {Map<string, (typeof seeds)[number]>} */
    const seedById = new Map(seeds.map((seed) => [seed.id, seed]));
    const runDirs = findRuns(runsDir);
    if (runDirs.length === 0) throw new Error(`${runsDir}: прогонов нет (сначала evals-pack)`);

    /** @type {Array<{ config: string, seed: string, stage: string, status: string, reason?: string, cost_rub?: number|null }>} */
    const runs = [];
    const skipped = [];

    for (const runDir of runDirs) {
      const meta = /** @type {Record<string, any>} */ (
        readJsonFile(join(runDir, 'meta.json'), 'meta.json')
      );
      const seed = seedById.get(meta.seed);
      if (seed === undefined) {
        skipped.push(`${meta.seed}: сида нет в каталоге`);
        continue;
      }

      const usageFile = join(runDir, 'usage.json');
      const usage = existsSync(usageFile)
        ? /** @type {Record<string, any>} */ (readJsonFile(usageFile, 'usage.json'))
        : null;

      let stageRuns = 0;
      for (const stage of SCORED_STAGES) {
        const file = join(runDir, `${stage}.md`);
        if (!existsSync(file)) continue;

        const result = scoreRun(seed, stage, readFileSync(file, 'utf8'));
        const model = meta.models?.[stage];
        let cost = null;
        if (usage !== null && typeof model === 'string' && usage[stage] !== undefined) {
          const tokens = /** @type {Record<string, any>} */ (usage[stage]);
          cost = priceStage({ prices: prices.models }, model, {
            calls_per_run: 0,
            input: Number(tokens.input ?? 0),
            cache_read: Number(tokens.cache_read ?? 0),
            output: Number(tokens.output ?? 0),
            reasoning: Number(tokens.reasoning ?? 0),
          }).total;
        }

        runs.push({
          config: String(meta.config ?? 'current'),
          seed: seed.id,
          stage,
          status: result.status,
          reason: result.reason,
          cost_rub: cost,
        });
        stageRuns += 1;
      }

      if (stageRuns === 0) skipped.push(`${meta.seed}: нет ответов этапов`);
    }

    if (runs.length === 0)
      throw new Error('прогонов с ответами нет: сначала заполните review.md/evaluate.md');

    const report = buildReport({
      runs,
      seeds: Object.fromEntries(seeds.map((seed) => [seed.id, seed.expect.kind])),
      thresholds: { completeness: args.completeness, false_positive_max: args.falsePositiveMax },
    });

    writeJsonAtomic(join(runsDir, 'report.json'), normalizeDoc(report), {
      serialize: (data) => `${JSON.stringify(data, null, 2)}\n`,
    });
    writeTextAtomic(join(runsDir, 'report.md'), renderMarkdown(report, runs, skipped));

    for (const line of renderLines(report, skipped)) process.stdout.write(`${line}\n`);

    if (report.failures.length > 0) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`evals-score: ${message}\n`);
    process.exitCode = 2;
  }
}

/**
 * Строки таблицы для человека.
 * @param {Record<string, any>} report
 * @param {string[]} skipped
 * @returns {string[]}
 */
function renderLines(report, skipped) {
  /** @type {string[]} */
  const lines = [];
  const header = `${'конфигурация'.padEnd(20)}${'сид'.padEnd(6)}${SCORED_STAGES.map((stage) => stage.padStart(10)).join('')}${'итог'.padStart(12)}`;
  lines.push(header);

  for (const config of Object.values(report.configs)) {
    for (const [seedId, seedEntry] of Object.entries(config.by_seed)) {
      const cells = SCORED_STAGES.map((stage) =>
        String(seedEntry.stages[stage] ?? '—').padStart(10),
      );
      lines.push(
        `${config.name.padEnd(20)}${seedId.padEnd(6)}${cells.join('')}${String(seedEntry.union).padStart(12)}`,
      );
    }
    const summary = config.summary;
    const completeness = summary.completeness === null ? '—' : summary.completeness.toFixed(2);
    const fp = summary.false_positive_rate === null ? '—' : summary.false_positive_rate.toFixed(2);
    const cost = summary.avg_cost_rub === null ? '—' : `${roundRub(summary.avg_cost_rub)} ₽`;
    lines.push(
      `  итог: полнота ${completeness} · ложные блокировки ${fp} · ₽/прогон ${cost} · уникальных попаданий review ${summary.exclusive.review}, evaluate ${summary.exclusive.evaluate}`,
    );
  }

  for (const item of skipped) lines.push(`  пропущено: ${item}`);
  lines.push(
    report.failures.length === 0
      ? `пороги: ok (полнота ≥ ${report.thresholds.completeness}, ложные ≤ ${report.thresholds.false_positive_max})`
      : `пороги: ниже порога — ${report.failures.join('; ')}`,
  );
  return lines;
}

/**
 * Отчёт в markdown: его прикладывают к issue и читают без запуска скриптов.
 * @param {Record<string, any>} report
 * @param {Array<Record<string, any>>} runs сырые прогоны: в них есть причины, которых нет в своде
 * @param {string[]} skipped
 * @returns {string}
 */
export function renderMarkdown(report, runs, skipped) {
  /** @type {string[]} */
  const lines = [
    '# Прогоны сидов',
    '',
    `Пороги: полнота ≥ ${report.thresholds.completeness}, ложные блокировки ≤ ${report.thresholds.false_positive_max}, допуск по строке ±${report.thresholds.line_tolerance}.`,
    'Вердикт `ok` значит «данные не противоречат порогам», а не «модель лучше».',
    '',
  ];

  for (const config of Object.values(report.configs)) {
    const summary = config.summary;
    lines.push(`## ${config.name}`, '');
    lines.push(`| сид | ${SCORED_STAGES.join(' | ')} | итог |`);
    lines.push(`| --- | ${SCORED_STAGES.map(() => '---').join(' | ')} | --- |`);
    for (const [seedId, seedEntry] of Object.entries(config.by_seed)) {
      const cells = SCORED_STAGES.map((stage) => seedEntry.stages[stage] ?? '—');
      lines.push(`| ${seedId} | ${cells.join(' | ')} | ${seedEntry.union} |`);
    }
    lines.push('');
    lines.push(
      `- полнота: ${summary.completeness === null ? '—' : summary.completeness.toFixed(2)} (${summary.hits} из ${summary.hits + summary.misses})`,
    );
    lines.push(
      `- ложные блокировки: ${summary.false_positive_rate === null ? '—' : summary.false_positive_rate.toFixed(2)} (${summary.false_positives} из ${summary.clean_runs})`,
    );
    lines.push(
      `- уникальные попадания: review ${summary.exclusive.review}, evaluate ${summary.exclusive.evaluate}`,
    );
    lines.push(
      `- стоимость прогона: ${summary.avg_cost_rub === null ? '—' : `${roundRub(summary.avg_cost_rub)} ₽`} (по ${config.cost_known} прогонам с usage)`,
    );
    lines.push('');
  }

  const invalid = runs.filter((run) => run.status === 'invalid');
  if (invalid.length > 0) {
    lines.push('## Не разобранные ответы', '');
    for (const run of invalid)
      lines.push(`- ${run.config} / ${run.seed} / ${run.stage}: ${run.reason}`);
    lines.push('');
  }

  if (skipped.length > 0) {
    lines.push('## Пропущено', '');
    for (const item of skipped) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('## Вердикт', '');
  lines.push(
    report.failures.length === 0
      ? 'Пороги не нарушены.'
      : `Ниже порога: ${report.failures.join('; ')}.`,
  );
  lines.push('');
  return lines.join('\n');
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
