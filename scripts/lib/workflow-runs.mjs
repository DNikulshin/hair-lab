/**
 * Извлечение `run:`-блоков из workflow GitHub Actions (issue #146).
 *
 * Зачем отдельный разбор: локальный `actionlint` работает без shellcheck (бинарника нет,
 * GitHub Releases режется сетью), поэтому shell-синтаксис run-блоков не проверялся до PR —
 * на этом CI упал в PR #145 (`SC1072`). Замена — `bash -n` по каждому run-блоку; чтобы её
 * запустить, скрипты нужно вынуть из YAML.
 *
 * Разбор намеренно текстовый и узкий (`yaml`-зависимости в проекте нет):
 * - берётся ключ `run:` на любом отступе, в том числе `- run:` первым ключом шага;
 * - поддерживаются блочные скаляры `|`, `|-`, `|+`, `>`, `>-`, `>+` и инлайн-значение;
 * - `script: |` (JS в `actions/github-script`) и прочие ключи не считаются run-блоками;
 * - имена job/step и `shell:` берутся по отступам workflow, отформатированного prettier
 *   (job — 2 пробела, `steps:` — 4, элемент списка шагов — 6, поля шага — 8); если файл
 *   отформатирован иначе, скрипты всё равно извлекаются, а подписи в отчёте просто пустые.
 *
 * `${{ … }}` в скриптах — не bash: перед `bash -n` выражения заменяются на `EXPR`
 * (`replaceExpressions`), иначе `${{` ломает разбор кавычек.
 */

/** Ключ `run:` в строке: отступ, необязательный маркер списка, значение после двоеточия. */
const RUN_KEY = /^([ \t]*)(- )?run:[ \t]*(.*)$/;

/** Ключ job в разделе `jobs:` (отступ 2). */
const JOB_KEY = /^ {2}([A-Za-z0-9_.-]+):[ \t]*(?:#.*)?$/;

/** Элемент списка шагов (отступ 6): начало нового шага. */
const STEP_ITEM = /^ {6}- (.*)$/;

/** Поле `name:` шага. */
const STEP_NAME = /^ {6}- name:[ \t]*(.*)$/;

/** Поле `shell:` шага. */
const STEP_SHELL = /^ {8}shell:[ \t]*([^#\s]+)/;

/** Индикатор блочного скаляра: `|`, `>`, с модификатором и/или отступом (`|2-`). */
const BLOCK_INDICATOR = /^[|>][+-]?\d*$/;

/**
 * Выражение GitHub Actions: `${{ … }}` может занимать несколько строк.
 * Заменяется на `EXPR` — валидное слово в любой позиции bash-синтаксиса.
 */
const EXPRESSION = /\$\{\{[\s\S]*?\}\}/g;

/**
 * Строка без завершающего комментария YAML — нужна только для значения после `run:`.
 * `#` внутри кавычек не встречается: значения run-блоков у нас блочные скаляры.
 * @param {string} value
 * @returns {string}
 */
function stripComment(value) {
  const hash = value.indexOf(' #');
  return (hash === -1 ? value : value.slice(0, hash)).trim();
}

/**
 * Отступ строки (пробелы).
 * @param {string} line
 * @returns {number}
 */
function indentOf(line) {
  let index = 0;
  while (index < line.length && line[index] === ' ') index += 1;
  return index;
}

/**
 * Свёрнутый блочный скаляр (`>`): непустые строки склеиваются пробелом, пустая строка
 * даёт перевод строки. Точная семантика YAML (`>` с отбивкой) здесь не нужна: результат
 * проверяется только на shell-синтаксис.
 * @param {string[]} lines
 * @returns {string}
 */
function foldBlock(lines) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  let buffer = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (buffer.length > 0) {
        out.push(buffer.join(' '));
        buffer = [];
      }
      out.push('');
      continue;
    }
    buffer.push(line.trim());
  }
  if (buffer.length > 0) out.push(buffer.join(' '));
  return out.join('\n');
}

/**
 * Разбирает инлайн-значение `run: <scalar>`: снимает кавычки, раскрывает `\n` и `\"`
 * в двойных кавычках (prettier так переносит многострочные строки).
 * @param {string} value
 * @returns {string}
 */
function inlineScalar(value) {
  const trimmed = stripComment(value);
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * @typedef {object} RunBlock
 * @property {string} file путь файла (как передан)
 * @property {number} line строка workflow, с которой начинается содержимое скрипта
 * @property {string|null} job имя job
 * @property {string|null} step подпись шага: `name` или первая строка элемента списка
 * @property {string|null} shell значение `shell:` шага
 * @property {string} script текст скрипта без `${{ … }}`
 */

/**
 * Все `run:`-блоки workflow в порядке файла.
 * @param {string} source содержимое workflow
 * @param {{ file?: string }} [options]
 * @returns {RunBlock[]}
 */
export function extractRunBlocks(source, options = {}) {
  if (typeof source !== 'string') throw new TypeError('extractRunBlocks: ожидается строка');
  const file = options.file ?? '';

  const lines = source.split(/\r?\n/);
  /** @type {RunBlock[]} */
  const blocks = [];

  let inJobs = false;
  /** @type {string|null} */
  let job = null;
  /** @type {string|null} */
  let step = null;
  /** @type {string|null} */
  let shell = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (/^jobs:[ \t]*$/.test(line)) {
      inJobs = true;
      job = null;
      continue;
    }
    if (!inJobs) continue;

    const jobMatch = JOB_KEY.exec(line);
    if (jobMatch !== null) {
      job = jobMatch[1];
      step = null;
      shell = null;
      continue;
    }

    const stepItem = STEP_ITEM.exec(line);
    if (stepItem !== null) {
      const name = STEP_NAME.exec(line);
      step = name === null ? stepItem[1].trim() : name[1].trim().replace(/^['"]|['"]$/g, '');
      shell = null;
      // `- run: …` — одновременно начало шага и run-блок: разбор продолжается ниже.
      if (!stepItem[1].startsWith('run:')) continue;
    }

    const shellMatch = STEP_SHELL.exec(line);
    if (shellMatch !== null) {
      shell = shellMatch[1].trim().replace(/^['"]|['"]$/g, '');
      continue;
    }

    const runMatch = RUN_KEY.exec(line);
    if (runMatch === null) continue;

    const leading = runMatch[1].length;
    const dash = runMatch[2] === undefined ? 0 : runMatch[2].length;
    // Блочный скаляр продолжается строками, отступ которых больше колонки ключа.
    const keyColumn = leading + dash;
    const value = stripComment(runMatch[3]);

    /** @type {string[]} */
    let content;
    /** 1-based строка workflow, с которой начинается содержимое скрипта. */
    let firstLine;
    let lastIndex = index;

    if (BLOCK_INDICATOR.test(value)) {
      const folded = value.startsWith('>');
      /** @type {string[]} */
      const raw = [];
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        const next = lines[cursor];
        if (next.trim() === '') {
          raw.push('');
          continue;
        }
        if (indentOf(next) <= keyColumn) break;
        raw.push(next);
      }
      lastIndex = cursor - 1;
      // Отступ содержимого — минимальный среди непустых строк.
      const contentIndent = raw
        .filter((entry) => entry.trim() !== '')
        .reduce((min, entry) => Math.min(min, indentOf(entry)), Number.POSITIVE_INFINITY);
      const stripped = raw.map((entry) => (entry.trim() === '' ? '' : entry.slice(contentIndent)));
      // Хвостовые пустые строки в блок не входят.
      while (stripped.length > 0 && stripped[stripped.length - 1] === '') stripped.pop();
      content = folded ? foldBlock(stripped).split('\n') : stripped;
      firstLine = index + 2; // строка сразу после `run:`
    } else {
      content = [inlineScalar(runMatch[3])];
      firstLine = index + 1;
    }

    const script = content.join('\n');
    blocks.push({
      file,
      line: firstLine,
      job,
      step,
      shell,
      script: replaceExpressions(script),
    });

    index = lastIndex;
  }

  return blocks;
}

/**
 * Заменяет выражения GitHub Actions на `EXPR`, чтобы `${{ … }}` не ломал bash-разбор.
 * @param {string} script
 * @returns {string}
 */
export function replaceExpressions(script) {
  if (typeof script !== 'string') throw new TypeError('replaceExpressions: ожидается строка');
  return script.replace(EXPRESSION, 'EXPR');
}

/**
 * Оболочки, для которых `bash -n` не применим: скрипт проверяется не bash.
 * @param {string|null} shell
 * @returns {boolean}
 */
export function isBashShell(shell) {
  if (shell === null || shell === undefined) return true; // по умолчанию на ubuntu-latest — bash
  const value = shell.toLowerCase();
  return value === 'bash' || value.startsWith('bash ');
}
