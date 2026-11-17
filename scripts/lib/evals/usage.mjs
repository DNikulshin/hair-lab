/**
 * Разбор транскриптов pi-субагентов: ответ агента и его токены (docs/evals.md).
 *
 * Транскрипт — JSONL, который pi пишет во время прогона. Он нужен потому, что
 * `<id>_<agent>_output.md` обрезается по размеру (наблюдалось на ответах оценщика
 * длиннее ~5 КБ — блок ```json терялся), а полный текст и `usage` каждого запроса
 * остаются в транскрипте.
 *
 * Модуль не знает про стадии и файлы прогона: он превращает записи в текст и суммы,
 * а решение, куда их положить, принимает CLI (`evals-collect`, `cycle-usage`).
 *
 * Shebang не нужен: модуль подключается из CLI-скриптов.
 */
import { readFileSync } from 'node:fs';

/**
 * Записи транскрипта. Битые строки пропускаются: файл пишется во время работы агента,
 * и последняя строка может быть недописана.
 * @param {string} file
 * @returns {Array<Record<string, any>>}
 */
export function readTranscript(file) {
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
 * @returns {{ input: number, cache_read: number, cache_write: number, output: number, reasoning: number }}
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
 * Сложение двух наборов токенов: несколько прогонов одной стадии (итерации `code`,
 * повтор `review` после доработки) складываются, а не затирают друг друга.
 * @param {{ input: number, cache_read: number, cache_write: number, output: number, reasoning: number, runs: number }} base
 * @param {{ input: number, cache_read: number, cache_write: number, output: number, reasoning: number }} addition
 * @returns {{ input: number, cache_read: number, cache_write: number, output: number, reasoning: number, runs: number }}
 */
export function addUsage(base, addition) {
  return {
    input: base.input + addition.input,
    cache_read: base.cache_read + addition.cache_read,
    cache_write: base.cache_write + addition.cache_write,
    output: base.output + addition.output,
    reasoning: base.reasoning + addition.reasoning,
    runs: base.runs + 1,
  };
}

/**
 * Пустой набор токенов стадии.
 * @returns {{ input: number, cache_read: number, cache_write: number, output: number, reasoning: number, runs: number }}
 */
export function emptyUsage() {
  return { input: 0, cache_read: 0, cache_write: 0, output: 0, reasoning: 0, runs: 0 };
}
