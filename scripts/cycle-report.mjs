#!/usr/bin/env node
/**
 * Сводка `metrics.json` по циклам (docs/orchestrator.md §11, §15, issue #224).
 *
 *   node scripts/cycle-report.mjs [--dir <каталог артефактов>] [--json]
 *
 * Скрипт читает `metrics.json` каждого каталога цикла в `.pi/artifacts/` (по умолчанию),
 * проверяет документ валидатором схемы и печатает markdown-таблицу: расход, итерации,
 * длительность, вклад этапов и исходы гейтов. Данные нужны для решения §15 «оставлять ли
 * этап `evaluate`» и для калибровки бюджетного порога (§11): расход и доля находок,
 * которые принёс только оценщик, считаются по факту, а не по памяти.
 *
 * **Только факты.** Скрипт не выносит вердиктов и не сравнивает с порогами: пороги —
 * в `LIMITS` (`config.mjs`) и в §15, а здесь агрегат. Ничего не пишет на диск.
 *
 * **Что попадает в отчёт.** Каталоги без `metrics.json` пропускаются (цикл не завершён или
 * метрики не собирались) — их число печатается отдельно, чтобы «нет данных» не выглядело
 * как «ноль». Битый или не проходящий схему `metrics.json` — отказ (код 2): молча
 * пропустить испорченный артефакт значило бы занизить расход.
 *
 * **Детерминизм.** Каталоги сортируются по имени, гейты — по порядку таблицы §5.5
 * (`GATES`), неизвестные id — после них по алфавиту; время и случайность не используются.
 * Два запуска на одном дереве дают побайтно одинаковый вывод.
 *
 * Коды выхода: `0` — отчёт напечатан; `2` — ошибка использования или данных (битый
 * `metrics.json`, нарушена схема, мусор в аргументах).
 * Shebang нужен: файл запускается напрямую.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GATES } from './lib/cycle/config.mjs';
import { readJson } from './lib/cycle/io.mjs';
import { FIXED_NAMES, artifactsDir, repoRoot } from './lib/cycle/paths.mjs';
import { validateMetrics } from './lib/cycle/validate.mjs';

/** Порядок гейтов в таблицах: как в §5.5, неизвестные id — после них по алфавиту. */
const GATE_ORDER = new Map(GATES.map((gate, index) => [gate.id, index]));

/** Серьёзности дефектов оценщика (Приложение A). */
const DEFECT_SEVERITIES = Object.freeze(['BLOCKER', 'MAJOR', 'MINOR']);

/** Статусы гейта (§5.5) — по ним ведутся исходы. */
const GATE_STATUSES = Object.freeze(['pass', 'fail', 'skipped', 'not_run']);

/** Нет данных: в ячейке честная прочерк, а не ноль. */
const NO_VALUE = '—';

/**
 * @typedef {object} CycleSummary
 * @property {string} name имя каталога цикла
 * @property {string} final_stage `final_stage` из `metrics.json`
 * @property {number} iterations
 * @property {number} max_iterations
 * @property {number} duration_s
 * @property {number|null} cost_rub расход или `null`, если замера нет
 * @property {{ only_review: number, only_evaluator: number, both: number }} findings
 * @property {Record<string, number>} evaluator_defects
 * @property {Record<string, number>} review_findings
 * @property {number} unresolved_refs
 * @property {number} unclosed_stages
 * @property {Record<string, Record<string, number>>} gate_outcomes
 */

/**
 * @typedef {object} Report
 * @property {CycleSummary[]} cycles
 * @property {number} skipped каталоги без `metrics.json`
 * @property {{ measured: number, total: number, sum: number|null, median: number|null }} cost
 * @property {{ evaluator_only: number, total: number, percent: number|null }} findings
 * @property {{ id: string, pass: number, fail: number, skipped: number, not_run: number }[]} gates
 */

/**
 * Число из `metrics.json` или `0`: поля необязательны в смысле «нечего показывать».
 * @param {unknown} value
 * @returns {number}
 */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Округление до сотых — как в `metrics.cost_rub`.
 * @param {number} value
 * @returns {number}
 */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Медиана чисел; `null` для пустого списка. Для чётного числа — среднее двух средних
 * (так же считается `alert = 2 × медиана` в §11).
 * @param {number[]} values
 * @returns {number|null}
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return round2(sorted[middle]);
  return round2((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * Процент от целого: `null`, если делить не на что. Одна цифра после запятой.
 * @param {number} part
 * @param {number} total
 * @returns {number|null}
 */
export function percent(part, total) {
  if (total <= 0) return null;
  return Math.round((part / total) * 1000) / 10;
}

/**
 * Строка расхода: рубли с копейками или прочерк, если замера не было.
 * @param {number|null} value
 * @returns {string}
 */
function rub(value) {
  return value === null ? NO_VALUE : value.toFixed(2);
}

/**
 * Строка процента.
 * @param {number|null} value
 * @returns {string}
 */
function percentText(value) {
  return value === null ? NO_VALUE : `${value.toFixed(1)}%`;
}

/**
 * Каталоги циклов с `metrics.json` в каталоге артефактов, отсортированные по имени.
 * @param {string} dir каталог артефактов
 * @returns {string[]} имена каталогов
 */
export function listCycleDirs(dir) {
  if (!existsSync(dir)) throw new Error(`${dir}: каталог артефактов не найден`);
  return readdirSync(dir)
    .filter((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() && existsSync(join(path, FIXED_NAMES.metrics));
    })
    .sort();
}

/**
 * Читает и проверяет `metrics.json` одного цикла. Сообщение содержит имя каталога, а не
 * абсолютный путь: отчёт можно вставлять в issue.
 * @param {string} dir каталог артефактов
 * @param {string} name имя каталога цикла
 * @returns {Record<string, any>}
 */
function readMetrics(dir, name) {
  const file = join(dir, name, FIXED_NAMES.metrics);

  /** @type {unknown} */
  let doc;
  try {
    doc = readJson(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${name}/${FIXED_NAMES.metrics}: не читается (${message})`, { cause: error });
  }

  const check = validateMetrics(doc);
  if (!check.ok) {
    throw new Error(`${name}/${FIXED_NAMES.metrics}: схема нарушена:\n${check.errors.join('\n')}`);
  }
  return /** @type {Record<string, any>} */ (doc);
}

/**
 * Сводка одного цикла: только поля, которые попадают в отчёт.
 * @param {string} name
 * @param {Record<string, any>} metrics
 * @returns {CycleSummary}
 */
export function summarizeCycle(name, metrics) {
  return {
    name,
    final_stage: metrics.final_stage,
    iterations: metrics.iterations,
    max_iterations: metrics.max_iterations,
    duration_s: metrics.cycle_duration_s,
    cost_rub: metrics.cost_rub ?? null,
    findings: {
      only_review: count(metrics.only_review),
      only_evaluator: count(metrics.only_evaluator),
      both: count(metrics.both),
    },
    evaluator_defects: Object.fromEntries(
      DEFECT_SEVERITIES.map((severity) => [severity, count(metrics.evaluator_defects?.[severity])]),
    ),
    review_findings: Object.fromEntries(
      ['BLOCKER', 'MAJOR', 'MINOR', 'FOLLOW-UP'].map((severity) => [
        severity,
        count(metrics.review_findings?.[severity]),
      ]),
    ),
    unresolved_refs: count(metrics.unresolved_refs),
    unclosed_stages: count(metrics.unclosed_stages),
    gate_outcomes: metrics.gate_outcomes ?? {},
  };
}

/**
 * Исходы гейтов по всем циклам: суммы по `id`, порядок — таблица §5.5, затем алфавит.
 * @param {CycleSummary[]} cycles
 * @returns {Report['gates']}
 */
export function aggregateGates(cycles) {
  /** @type {Map<string, Record<string, number>>} */
  const totals = new Map();
  for (const cycle of cycles) {
    for (const [id, outcomes] of Object.entries(cycle.gate_outcomes)) {
      if (totals.has(id) === false) {
        totals.set(id, Object.fromEntries(GATE_STATUSES.map((status) => [status, 0])));
      }
      const entry = /** @type {Record<string, number>} */ (totals.get(id));
      for (const status of GATE_STATUSES) entry[status] += count(outcomes?.[status]);
    }
  }

  return [...totals.entries()]
    .sort(([left], [right]) => {
      const leftIndex = GATE_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = GATE_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER;
      if (leftIndex !== rightIndex) return leftIndex - rightIndex;
      return left < right ? -1 : left > right ? 1 : 0;
    })
    .map(([id, entry]) => ({ id, ...entry }));
}

/**
 * Собирает отчёт из прочитанных метрик. Чистая функция: файлов не читает.
 * @param {CycleSummary[]} cycles сводки по циклам (в порядке отчёта)
 * @param {{ skipped?: number }} [options]
 * @returns {Report}
 */
export function buildReport(cycles, { skipped = 0 } = {}) {
  const costs = cycles.map((cycle) => cycle.cost_rub).filter((value) => value !== null);
  const evaluatorOnly = cycles.reduce((sum, cycle) => sum + cycle.findings.only_evaluator, 0);
  const totalFindings = cycles.reduce(
    (sum, cycle) =>
      sum + cycle.findings.only_review + cycle.findings.only_evaluator + cycle.findings.both,
    0,
  );

  return {
    cycles,
    skipped,
    cost: {
      measured: costs.length,
      total: cycles.length,
      sum: costs.length === 0 ? null : round2(costs.reduce((sum, value) => sum + value, 0)),
      median: median(costs),
    },
    findings: {
      evaluator_only: evaluatorOnly,
      total: totalFindings,
      percent: percent(evaluatorOnly, totalFindings),
    },
    gates: aggregateGates(cycles),
  };
}

/**
 * Отчёт в markdown: шапка с итогами, таблица циклов, таблица гейтов.
 * @param {Report} report
 * @returns {string}
 */
export function renderMarkdown(report) {
  const { cycles, cost, findings, skipped, gates } = report;
  /** @type {string[]} */
  const lines = ['# Отчёт по циклам', ''];

  if (cycles.length === 0) {
    lines.push(
      'Циклов с `metrics.json` нет: собирать нечего.',
      '',
      `Пропущено каталогов без \`${FIXED_NAMES.metrics}\`: ${skipped}.`,
      '',
    );
    return lines.join('\n');
  }

  lines.push(
    `Циклов: ${cost.total}, с расходом: ${cost.measured}.` +
      ` Расход: ${rub(cost.sum)} ₽, медиана: ${rub(cost.median)} ₽.`,
    '',
    `Находок только у оценщика: ${findings.evaluator_only} из ${findings.total}` +
      ` (${percentText(findings.percent)}).`,
    '',
    `Пропущено каталогов без \`${FIXED_NAMES.metrics}\`: ${skipped}.`,
    '',
    '| Цикл | Стадия | Итераций | Время, с | Расход, ₽ | Только оценщик | Только ревью | Оба | Дефекты оценщика B/M/m | Неразрешённые ссылки | Незакрытые этапы |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );

  for (const cycle of cycles) {
    const defects = cycle.evaluator_defects;
    lines.push(
      `| ${cycle.name} | ${cycle.final_stage} | ${cycle.iterations}/${cycle.max_iterations}` +
        ` | ${Math.round(cycle.duration_s)} | ${rub(cycle.cost_rub)}` +
        ` | ${cycle.findings.only_evaluator} | ${cycle.findings.only_review} | ${cycle.findings.both}` +
        ` | ${defects.BLOCKER}/${defects.MAJOR}/${defects.MINOR}` +
        ` | ${cycle.unresolved_refs} | ${cycle.unclosed_stages} |`,
    );
  }

  lines.push('', '## Исходы гейтов', '');
  if (gates.length === 0) {
    lines.push('Гейты в метриках не зафиксированы.', '');
  } else {
    lines.push('| Гейт | pass | fail | skipped | not_run |', '| --- | --- | --- | --- | --- |');
    for (const gate of gates) {
      lines.push(
        `| ${gate.id} | ${gate.pass} | ${gate.fail} | ${gate.skipped} | ${gate.not_run} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Разбирает аргументы командной строки. Любой мусор — ошибка использования (код 2).
 * @param {string[]} argv
 * @returns {{ dir: string|null, json: boolean }}
 */
export function parseArgs(argv) {
  /** @type {string|null} */
  let dir = null;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
        throw new Error('--dir: ожидается путь к каталогу артефактов');
      }
      dir = value;
      index += 1;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    throw new Error(`неизвестный аргумент: ${arg}`);
  }

  return { dir, json };
}

/**
 * Точка входа CLI: печатает отчёт в stdout, на диск не пишет.
 * @returns {void}
 */
function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const dir = args.dir === null ? artifactsDir(repoRoot()) : resolve(args.dir);

    const names = listCycleDirs(dir);
    const cycles = names.map((name) => summarizeCycle(name, readMetrics(dir, name)));
    const skipped = readdirSync(dir).filter((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() && !existsSync(join(path, FIXED_NAMES.metrics));
    }).length;

    const report = buildReport(cycles, { skipped });
    process.stdout.write(args.json ? `${JSON.stringify(report)}\n` : renderMarkdown(report));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cycle-report: ${message}\n`);
    process.exitCode = 2;
  }
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
