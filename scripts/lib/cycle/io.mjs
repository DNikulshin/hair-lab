/**
 * Файловый ввод-вывод ядра цикла (docs/orchestrator-core.md §5.2).
 *
 * Запись атомарная: сериализация до записи, временный файл в том же каталоге, затем rename.
 * Частично записанных артефактов быть не должно — на них опирается протокол супервизора.
 * Shebang не нужен: модуль подключается из CLI-скриптов `cycle-*.mjs`.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Счётчик временных файлов процесса: имена не должны совпадать при вложенных вызовах. */
let tmpCounter = 0;

/**
 * Читает JSON-файл. Битый JSON и отсутствие файла — исключение: молча возвращать
 * значение по умолчанию нельзя, это скрыло бы повреждённый state цикла.
 * @template T
 * @param {string} file
 * @returns {T}
 */
export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Атомарно пишет данные как JSON: `tmp` в каталоге цели → `renameSync`.
 * Если сериализация или запись падает, целевой файл остаётся прежним,
 * а временный файл удаляется; ошибка пробрасывается вызывающему.
 * @param {string} file целевой путь
 * @param {unknown} data данные
 * @param {{ serialize?: (data: unknown) => string }} [options]
 *   `serialize` — способ представления (по умолчанию компактный `JSON.stringify`;
 *   для читаемых артефактов вызывающий передаёт сериализатор с отступами)
 * @returns {void}
 */
export function writeJsonAtomic(file, data, { serialize = JSON.stringify } = {}) {
  // Сериализация выполняется до любой записи: сбой не должен трогать существующий файл.
  const text = serialize(data);
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${(tmpCounter += 1)}.tmp`);

  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Временного файла может уже не быть (например, не удалось его создать) — это нормально.
    }
    throw error;
  }
}

/**
 * Хвост файла: последние `lines` строк без завершающего перевода строки.
 * Используется для логов упавших гейтов (страница `evidence/`).
 * @param {string} file
 * @param {number} lines сколько строк оставить (≤ 0 — пустая строка)
 * @returns {string}
 */
export function tail(file, lines) {
  const limit = Math.trunc(lines);
  if (limit <= 0) return '';

  const text = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  if (text === '') return '';

  return text.split(/\r?\n/).slice(-limit).join('\n');
}

/** Размеченный блок кода: ```json … ``` (немаркированные блоки не считаются). */
const JSON_BLOCK = /```json[ \t]*\r?\n([\s\S]*?)```/g;

/**
 * Последний блок ```json из markdown-вывода агента. Берём именно последний:
 * агент может сначала привести пример, а итоговый ответ дать ниже.
 * Нет блока или JSON не разбирается — исключение (для `cycle-decide` это сигнал
 * `agent_output_invalid`).
 * @param {string} markdown
 * @returns {unknown}
 */
export function extractLastJsonBlock(markdown) {
  const blocks = [...markdown.matchAll(JSON_BLOCK)];
  const last = blocks.at(-1);
  if (!last) {
    throw new Error('в markdown нет размеченного блока ```json');
  }

  try {
    return JSON.parse(last[1]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Причина сохраняется: диагностика битого вывода агента должна быть полной.
    throw new Error(`последний блок \`\`\`json не разбирается как JSON: ${reason}`, {
      cause: error,
    });
  }
}
