#!/usr/bin/env node
/**
 * Фактический расход токенов этапов цикла (docs/orchestrator-core.md §5.8, R5).
 *
 * Почему отдельным скриптом, а не внутри `cycle-metrics`: токены берутся из транскриптов
 * субагентов, которые лежат вне каталога цикла и появляются по одному после каждого
 * этапа. Супервизор вызывает эту команду сразу после этапа, а метрики потом читают
 * уже готовый `usage.json`. Так у каждого этапа один источник и нет разбора
 * транскриптов в момент сборки отчёта.
 *
 * Вход: каталог цикла (с `state.json`) и транскрипт одного прогона субагента.
 * Выход: `<каталог>/usage.json` — суммы по этапам, дописываются, не затираются:
 *
 * ```json
 * { "code": { "runs": 2, "input": 914, "cache_read": 51000, "cache_write": 0, "output": 640, "reasoning": 310 } }
 * ```
 *
 * Пишет только внутрь `.pi/artifacts/`. Сеть не используется.
 *
 * Коды выхода: `0` — расход собран; `2` — ошибка использования или данных.
 * Shebang нужен: файл запускается напрямую.
 */
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addUsage, emptyUsage, readTranscript, sumUsage } from './lib/evals/usage.mjs';
import { readJson, writeJsonAtomic } from './lib/cycle/io.mjs';
import { FIXED_NAMES, artifactsDir, repoRoot } from './lib/cycle/paths.mjs';

/** Этапы, на которых вызывается модель. `GATES`/`QA_WEB` — процессы, а не токены. */
export const USAGE_STAGES = Object.freeze(['plan', 'code', 'review', 'evaluate']);

/**
 * Разбирает аргументы командной строки.
 * @param {string[]} argv
 * @returns {{ dir: string|null, stage: string|null, transcript: string|null, root: string|null }}
 */
export function parseArgs(argv) {
  /** @type {{ dir: string|null, stage: string|null, transcript: string|null, root: string|null }} */
  const args = { dir: null, stage: null, transcript: null, root: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const key = arg.startsWith('--') ? arg.slice(2) : null;
    if (key === 'dir' || key === 'stage' || key === 'transcript' || key === 'root') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
        throw new Error(`${arg}: ожидается значение`);
      }
      args[/** @type {'dir'|'stage'|'transcript'|'root'} */ (key)] = value.trim();
      index += 1;
      continue;
    }
    throw new Error(`неизвестный аргумент: ${arg}`);
  }

  return args;
}

/**
 * Дописывает расход одного прогона в карту этапов.
 *
 * Чистая функция: не читает и не пишет файлы — её проверяют тесты без фикстур
 * и без транскриптов.
 * @param {Record<string, any>|null} previous прежнее содержимое `usage.json` или `null`
 * @param {string} stage этап из `USAGE_STAGES`
 * @param {{ input: number, cache_read: number, cache_write: number, output: number, reasoning: number }} run расход прогона
 * @returns {Record<string, any>} новая карта, прежняя не меняется
 */
export function addStageUsage(previous, stage, run) {
  if (!USAGE_STAGES.includes(stage)) {
    throw new Error(`этап ${stage}: ожидается ${USAGE_STAGES.join('|')}`);
  }
  const source = previous ?? {};
  const current = source[stage];
  const base = current === undefined ? emptyUsage() : { ...emptyUsage(), ...current };
  return { ...source, [stage]: addUsage(base, run) };
}

/**
 * Точка входа CLI.
 * @returns {void}
 */
function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.dir === null) throw new Error('--dir: обязателен (каталог цикла)');
    if (args.stage === null || !USAGE_STAGES.includes(args.stage)) {
      throw new Error(`--stage: ожидается ${USAGE_STAGES.join('|')}`);
    }
    if (args.transcript === null) throw new Error('--transcript: обязателен (путь к *.jsonl)');

    const root = args.root === null ? repoRoot() : resolve(args.root);
    const cycleDir = resolve(args.dir);
    const artifacts = artifactsDir(root);
    if (!cycleDir.startsWith(`${artifacts}${sep}`)) {
      throw new Error(`каталог цикла должен быть внутри ${join('.pi', 'artifacts')}`);
    }
    if (!existsSync(join(cycleDir, FIXED_NAMES.state))) {
      throw new Error(`в каталоге цикла нет ${FIXED_NAMES.state}`);
    }

    const records = readTranscript(args.transcript);
    if (records.length === 0) throw new Error('транскрипт пуст или не читается');

    const usageFile = join(cycleDir, FIXED_NAMES.usage);
    const previous = existsSync(usageFile) ? /** @type {any} */ (readJson(usageFile)) : null;
    const usage = addStageUsage(previous, args.stage, sumUsage(records));
    writeJsonAtomic(usageFile, usage, {
      serialize: (data) => `${JSON.stringify(data, null, 2)}\n`,
    });

    const stage = usage[args.stage];
    process.stdout.write(
      [
        `расход: ${join(cycleDir, FIXED_NAMES.usage)}`,
        `  этап ${args.stage}: прогонов ${stage.runs}, вход ${stage.input}, кэш ${stage.cache_read}, вывод ${stage.output}`,
        '',
      ].join('\n'),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cycle-usage: ${message}\n`);
    process.exitCode = 2;
  }
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
