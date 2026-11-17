#!/usr/bin/env node
/**
 * Стоимость стадий и полного цикла по ценам провайдера (docs/evals.md).
 *
 * Вход: `evals/prices.json` (снапшот цен), `evals/profiles.json` (профили нагрузки
 * стадий), `evals/candidates.json` (матрица экспериментов) и `.pi/agents/*.md`
 * (текущая конфигурация — единственный источник истины о моделях).
 *
 * Выход: таблица ₽ в stdout или тот же результат как JSON с `--json`. Файлов не пишет:
 * это справочный расчёт, а не артефакт цикла.
 *
 * Считается прогон стадии и «цикл» — по одному прогону `plan`, `code`, `review`,
 * `evaluate`. Дополнительные итерации `code` сюда не входят: они зависят от исхода
 * цикла, а не от цен, и добавляются в уме как `N × code`.
 *
 * `--model <id>` добавляет строку «все стадии на этой модели»: так видно, во что
 * обойдётся кандидат, которого ещё нет в матрице экспериментов.
 *
 * Коды выхода: `0` — таблица построена; `2` — ошибка использования или данных
 * (битый снапшот, модели нет в ценах, неизвестный аргумент).
 * Shebang нужен: файл запускается напрямую.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAgentModels } from './lib/evals/agents.mjs';
import {
  STAGES,
  applyDelta,
  formatDelta,
  formatRub,
  priceCycle,
  readCandidates,
  readPrices,
  readProfiles,
} from './lib/evals/cost.mjs';
import { repoRoot } from './lib/cycle/paths.mjs';

/**
 * Читает JSON-файл. Сообщение об ошибке содержит имя файла, а не абсолютный путь:
 * диагностика не должна зависеть от расположения дерева.
 * @param {string} file
 * @param {string} label
 * @returns {unknown}
 */
function readJsonFile(file, label) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = /** @type {{ code?: unknown } | undefined} */ (error)?.code;
    throw new Error(
      `${label}: не читается (${typeof code === 'string' ? code : 'ошибка доступа'})`,
      { cause: error },
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}: битый JSON`);
  }
}

/**
 * Разбирает аргументы командной строки. Мусор — ошибка использования (код 2).
 * @param {string[]} argv
 * @returns {{
 *   root: string|null,
 *   prices: string|null,
 *   profiles: string|null,
 *   candidates: string|null,
 *   models: string[],
 *   json: boolean,
 * }}
 */
export function parseArgs(argv) {
  /** @type {{ root: string|null, prices: string|null, profiles: string|null, candidates: string|null, models: string[], json: boolean }} */
  const args = {
    root: null,
    prices: null,
    profiles: null,
    candidates: null,
    models: [],
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--model') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
        throw new Error('--model: ожидается идентификатор модели');
      }
      args.models.push(value.trim());
      index += 1;
      continue;
    }
    if (arg === '--root' || arg === '--prices' || arg === '--profiles' || arg === '--candidates') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
        throw new Error(`${arg}: ожидается путь`);
      }
      const key = /** @type {'root'|'prices'|'profiles'|'candidates'} */ (arg.slice(2));
      args[key] = value;
      index += 1;
      continue;
    }
    throw new Error(`неизвестный аргумент: ${arg}`);
  }

  return args;
}

/**
 * Строка таблицы: имя, четыре стадии, цикл и дельта к текущей конфигурации.
 * @param {{ name: string, stages: Record<string, number>, total: number }} row
 * @param {number|null} baseline
 * @returns {string}
 */
function formatRow(row, baseline) {
  const cells = STAGES.map((stage) => formatRub(row.stages[stage]).padStart(10));
  const total = formatRub(row.total).padStart(10);
  const difference = baseline === null ? '' : formatDelta(row.total - baseline);
  return `${row.name.padEnd(24)}${cells.join('')}${total}${difference.padStart(10)}`;
}

/**
 * Точка входа CLI.
 * @returns {void}
 */
function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const root = args.root === null ? repoRoot() : resolve(args.root);

    const prices = readPrices(
      readJsonFile(args.prices ?? join(root, 'evals', 'prices.json'), 'evals/prices.json'),
    );
    const profiles = readProfiles(
      readJsonFile(args.profiles ?? join(root, 'evals', 'profiles.json'), 'evals/profiles.json'),
    );
    const candidates = readCandidates(
      readJsonFile(
        args.candidates ?? join(root, 'evals', 'candidates.json'),
        'evals/candidates.json',
      ),
    );

    const current = readAgentModels(root);

    /** @type {Array<{ name: string, models: Record<string, string>, stages: Record<string, number>, total: number }>} */
    const rows = [];

    const baseCycle = priceCycle({ prices: prices.models, profiles: profiles.stages }, current);
    rows.push({
      name: 'current (агенты)',
      models: current,
      stages: Object.fromEntries(STAGES.map((stage) => [stage, baseCycle.stages[stage].total])),
      total: baseCycle.total,
    });

    for (const [name, candidate] of Object.entries(candidates)) {
      const models = applyDelta(current, candidate.models);
      const cycle = priceCycle({ prices: prices.models, profiles: profiles.stages }, models);
      rows.push({
        name,
        models,
        stages: Object.fromEntries(STAGES.map((stage) => [stage, cycle.stages[stage].total])),
        total: cycle.total,
      });
    }

    for (const model of args.models) {
      const models = Object.fromEntries(STAGES.map((stage) => [stage, model]));
      const cycle = priceCycle({ prices: prices.models, profiles: profiles.stages }, models);
      rows.push({
        name: model,
        models,
        stages: Object.fromEntries(STAGES.map((stage) => [stage, cycle.stages[stage].total])),
        total: cycle.total,
      });
    }

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify({
          currency: 'RUB',
          rows: rows.map((row) => ({
            name: row.name,
            models: row.models,
            stages: Object.fromEntries(
              STAGES.map((stage) => [stage, Number(row.stages[stage].toFixed(4))]),
            ),
            total: Number(row.total.toFixed(4)),
          })),
        })}\n`,
      );
      return;
    }

    const header = `${'конфигурация'.padEnd(24)}${STAGES.map((stage) => stage.padStart(10)).join('')}${'цикл'.padStart(10)}${'Δ'.padStart(10)}`;
    process.stdout.write(`${header}\n`);
    const baseline = rows[0].total;
    rows.forEach((row, index) => {
      process.stdout.write(`${formatRow(row, index === 0 ? null : baseline)}\n`);
    });
    process.stdout.write(
      '\nцена за один прогон стадии, ₽; цикл = plan + code + review + evaluate; Δ — к текущей конфигурации\n',
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`evals-cost: ${message}\n`);
    process.exitCode = 2;
  }
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
