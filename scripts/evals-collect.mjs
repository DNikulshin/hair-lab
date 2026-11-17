#!/usr/bin/env node
/**
 * Сбор ответа субагента в каталог прогона (docs/evals.md).
 *
 * Зачем отдельный шаг: pi сохраняет ответ субагента в двух местах, и они не равноценны.
 * `<id>_<agent>_output.md` обрезается по размеру (наблюдалось на ответах оценщика
 * длиннее ~5 КБ), а полный текст последнего сообщения лежит в
 * `<id>_<agent>_transcript.jsonl`. Скоринг обязан видеть полный ответ, иначе валидный
 * блок ```json теряется и этап выглядит сломанным.
 *
 * Скрипт делает два дела и ничего больше:
 *
 * 1. вытаскивает текст последнего ответа ассистента из транскрипта и пишет его в
 *    `<run>/<stage>.md`;
 * 2. дописывает в `<run>/usage.json` фактические токены этого прогона — из тех же
 *    записей транскрипта. Стоимость в `evals-score` считается по ним, а не по среднему
 *    профилю, поэтому цифры в отчёте остаются фактом.
 *
 * Пишет только внутрь `.pi/artifacts/evals/`. Сеть не используется.
 *
 * Коды выхода: `0` — ответ собран; `2` — ошибка использования или данных.
 * Shebang нужен: файл запускается напрямую.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCORED_STAGES } from './lib/evals/score.mjs';
import { readJson, writeJsonAtomic, writeTextAtomic } from './lib/cycle/io.mjs';
import { artifactsDir, repoRoot } from './lib/cycle/paths.mjs';

/**
 * Разбирает аргументы командной строки.
 * @param {string[]} argv
 * @returns {{ run: string|null, stage: string|null, transcript: string|null, out: string|null, root: string|null }}
 */
export function parseArgs(argv) {
  /** @type {{ run: string|null, stage: string|null, transcript: string|null, out: string|null, root: string|null }} */
  const args = { run: null, stage: null, transcript: null, out: null, root: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const key = arg.startsWith('--') ? arg.slice(2) : null;
    if (
      key === 'run' ||
      key === 'stage' ||
      key === 'transcript' ||
      key === 'out' ||
      key === 'root'
    ) {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('--')) {
        throw new Error(`${arg}: ожидается значение`);
      }
      args[/** @type {'run'|'stage'|'transcript'|'out'|'root'} */ (key)] = value.trim();
      index += 1;
      continue;
    }
    throw new Error(`неизвестный аргумент: ${arg}`);
  }

  return args;
}

/**
 * Записи транскрипта. Битые строки пропускаются: файл пишется во время работы агента,
 * и последняя строка может быть недописана.
 * @param {string} file
 * @returns {Array<Record<string, any>>}
 */
function readTranscript(file) {
  /** @type {Array<Record<string, any>>} */
  const records = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Недописанная строка — не повод терять весь прогон.
    }
  }
  return records;
}

/**
 * Текст последнего ответа ассистента. Собираются только текстовые части: вызовы
 * инструментов в ответ не входят, как и в живой записи `review.<n>.md`.
 * @param {Array<Record<string, any>>} records
 * @returns {string}
 */
export function lastAssistantText(records) {
  /** @type {string[]} */
  const texts = [];

  for (const record of records) {
    if (record.recordType !== 'message' || record.role !== 'assistant') continue;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;

    const parts = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text);
    if (parts.length === 0) continue;
    texts.push(parts.join('\n'));
  }

  return texts.length === 0 ? '' : /** @type {string} */ (texts[texts.length - 1]);
}

/**
 * Суммарные токены прогона: каждая запись ответа ассистента несёт `usage` своего запроса,
 * сумма по ним — стоимость всего прогона, включая промежуточные шаги с инструментами.
 * @param {Array<Record<string, any>>} records
 * @returns {{ input: number, cache_read: number, cache_write: number, output: number, reasoning: number } }
 */
export function sumUsage(records) {
  const total = { input: 0, cache_read: 0, cache_write: 0, output: 0, reasoning: 0 };

  for (const record of records) {
    if (record.recordType !== 'message' || record.role !== 'assistant') continue;
    const usage = record.message?.usage ?? record.usage;
    if (usage === null || typeof usage !== 'object') continue;
    total.input += Number(usage.input ?? 0);
    total.cache_read += Number(usage.cacheRead ?? 0);
    total.cache_write += Number(usage.cacheWrite ?? 0);
    total.output += Number(usage.output ?? 0);
    total.reasoning += Number(usage.reasoning ?? 0);
  }

  return total;
}

/**
 * Точка входа CLI.
 * @returns {void}
 */
function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.run === null) throw new Error('--run: обязателен (каталог прогона)');
    if (args.stage === null || !SCORED_STAGES.includes(args.stage)) {
      throw new Error(`--stage: ожидается ${SCORED_STAGES.join('|')}`);
    }
    if (args.transcript === null) throw new Error('--transcript: обязателен (путь к *.jsonl)');

    const root = args.root === null ? repoRoot() : resolve(args.root);
    const runDir = resolve(args.run);
    const evalsRoot = join(artifactsDir(root), 'evals');
    if (!runDir.startsWith(`${evalsRoot}${sep}`)) {
      throw new Error(`каталог прогона должен быть внутри ${join('.pi', 'artifacts', 'evals')}`);
    }
    if (!existsSync(join(runDir, 'meta.json'))) {
      throw new Error('в каталоге прогона нет meta.json: сначала evals-pack');
    }

    const records = readTranscript(args.transcript);
    if (records.length === 0) throw new Error('транскрипт пуст или не читается');

    const text = lastAssistantText(records);
    if (text.trim() === '') throw new Error('в транскрипте нет текстового ответа ассистента');

    const outName = args.out ?? `${args.stage}.md`;
    writeTextAtomic(join(runDir, outName), `${text}\n`);

    const usageFile = join(runDir, 'usage.json');
    /** @type {Record<string, unknown>} */
    const usage = existsSync(usageFile) ? /** @type {any} */ (readJson(usageFile)) : {};
    usage[args.stage] = sumUsage(records);
    writeJsonAtomic(usageFile, usage, {
      serialize: (data) => `${JSON.stringify(data, null, 2)}\n`,
    });

    const hasBlock = text.includes('```json');
    process.stdout.write(
      [
        `собрано: ${join(runDir, outName)}`,
        `  стадия: ${args.stage}, символов: ${text.length}, блок json: ${hasBlock ? 'есть' : 'НЕТ'}`,
        `  токены: вход ${usage[args.stage].input}, кэш ${usage[args.stage].cache_read}, вывод ${usage[args.stage].output}`,
        '',
      ].join('\n'),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`evals-collect: ${message}\n`);
    process.exitCode = 2;
  }
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
