#!/usr/bin/env node
/**
 * Пакет свидетельств для независимого оценщика по docs/orchestrator-core.md §5.4
 * (issue #155, задача T4; docs/orchestrator.md §7; docs/adr/0006-independent-evaluation.md).
 *
 * Подкоманды:
 *
 *   criteria --dir D [--issue-json F]   критерии приёмки из issue (этап INIT)
 *   packet   --dir D [--base SHA]       сборка каталога `evidence/` для оценщика
 *
 * `--dir` по умолчанию — единственный активный цикл (`findActiveCycle`), `--issue-json` —
 * `<dir>/issue.json` (файл готовит супервизор командой `gh issue view`; сеть и `gh` скрипт
 * не вызывает). Вывод — одна строка JSON в stdout, диагностика — в stderr; результат
 * `criteria` и `packet` — сами файлы каталога цикла.
 *
 * **Куда можно писать (§4).** Каталог цикла внутри репозитория обязан лежать в
 * `<root>/.pi/artifacts/`: другие каталоги репозитория отклоняются кодом 2, файлы не
 * создаются. Каталог вне корня репозитория разрешён — на этом построены тесты и ручной
 * smoke на временных git-репозиториях в `/tmp`. Проверка идёт по каноническим путям
 * (`realpathSync`), поэтому символическая ссылка не обходит ограничение.
 *
 * **Критерии.** Тело issue разбирается как форма GitHub: секции `### <заголовок>`, поле
 * `_No response_` считается пустым. Шаблон определяется по наличию секций: `Критерии
 * приёмки` (feature), `Готово, когда` (task), `Ожидаемый результат` (bug). Приоритет —
 * в этом же порядке; метка `type:bug` поднимает `Ожидаемый результат` на первое место,
 * если ручные правки оставили в issue обе секции. Пункты — элементы списка (`- `, `* `,
 * `1.`, `- [ ]`, `- [x]`) → `C1…Cn`, формулировка дословно (маркер срезается). Строки
 * продолжения пункта (без маркера, до следующего маркера, пустой строки или конца секции)
 * присоединяются к формулировке через один пробел, поэтому многострочный пункт — один
 * критерий; пустая строка закрывает пункт, и абзац после списка критерием не становится.
 * Для bug без списка критерием становится весь текст секции (`C1`), приведённый к одной
 * строке: `- C1: …` в `criteria.md` — строчный контракт для оценщика. Нет секции, она
 * пуста или (вне bug) в ней нет элементов списка → код 2, `criteria_missing`.
 *
 * **Пакет.** Перед диффом выполняется `intentToAddUntracked()` (§4): иначе untracked-файлы
 * не видны ни в `git diff`, ни оценщику. База диффа: `--base` → `gates.<n>.json.base_sha` →
 * `state.base_sha`; приоритет гейтов сохраняет консистентность с прогоном проверок
 * (`base_sha` документа пишет `cycle-gates`). Значение резолвится в полный sha
 * (`resolveBaseSha`), нерезолвящаяся база — код 2. Затем копируются `gates.<n>.json`
 * (байт-в-байт), хвосты логов упавших гейтов (≤ `LIMITS.evidenceTailLines` строк; логи
 * прошедших и пропущенных гейтов не копируются) и `qa-web.json`, если файл есть. Путь лога
 * из документа гейтов — данные: он канонизируется (`realpathSync` каталога цикла и файла),
 * и логи, оказавшиеся после разрешения символических ссылок вне каталога цикла, в пакет
 * не попадают. Пакет собирается в памяти и пишется только при успехе: при ошибке файлы
 * не создаются и не перезаписываются.
 *
 * **Маскирование (§5.4).** В логи гейтов, сырые данные QA и `diff.patch` применяется
 * `redactLog`/`redactQa`: e-mail → `[email]`, телефоны → `[phone]`, `authorization`/
 * `cookie`/JWT/`postgres://<user>:<pass>@`/`key|token|secret|password…` → `[secret]`.
 * Структура диффа при этом не меняется: шаблоны не содержат переводов строк, поэтому
 * строки не удаляются и не склеиваются, а номера строк и `@@`-заголовки остаются прежними.
 * Хэши коммитов, UUID и номера строк маскировке не подлежат.
 *
 * **Лимиты (§5.2).** По сырому диффу: изменённых строк (`+`/`-` внутри ханков, без
 * `+++`/`---` и контекста) больше `LIMITS.maxDiffLines` или размер больше
 * `LIMITS.maxDiffBytes` → код 4, `diff_too_large`, файлы не пишутся; ровно на границе — успех.
 *
 * Маскировка issue body в `evidence/issue.md` и `criteria.md` не выполняется: §5.4
 * перечисляет только логи, сырые данные QA и дифф, а формулировки критериев оценщик
 * сверяет с issue дословно.
 *
 * **Коды выхода (§4).** `0` — успех; `2` — ошибка использования, внутренняя ошибка или
 * `criteria_missing`; `4` — `diff_too_large`. Коды `1` и `3` в этом скрипте не используются:
 * гейтов и переходов автомата здесь нет.
 *
 * Shebang нужен: файл запускается напрямую.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeDoc } from './cycle-decide.mjs';
import { resolveBaseSha } from './cycle-gates.mjs';
import { LIMITS } from './lib/cycle/config.mjs';
import { diffFromBase, intentToAddUntracked } from './lib/cycle/git.mjs';
import { readJson, tail, writeTextAtomic } from './lib/cycle/io.mjs';
import {
  FIXED_NAMES,
  artifactsDir,
  findActiveCycle,
  iterNames,
  repoRoot,
} from './lib/cycle/paths.mjs';
import { redactLog, redactQa } from './lib/cycle/redact.mjs';
import { validateGates, validateQaWeb, validateState } from './lib/cycle/validate.mjs';

/** Заголовки секций форм issue (`.github/ISSUE_TEMPLATE/*.yml`). */
const SECTIONS = Object.freeze({
  feature: 'Критерии приёмки',
  task: 'Готово, когда',
  bug: 'Ожидаемый результат',
});

/** Шаблон формы по заголовку секции: секции трёх форм не пересекаются. */
const TEMPLATE_BY_SECTION = Object.freeze({
  [SECTIONS.feature]: 'feature',
  [SECTIONS.task]: 'task',
  [SECTIONS.bug]: 'bug',
});

/** Метка bug-issue: при коллизии секций поднимает `Ожидаемый результат` на первое место. */
const BUG_LABEL = 'type:bug';

/** Значение пустого поля формы GitHub. */
const EMPTY_FIELD = '_No response_';

/** Причина отказа §5.4: критериев в issue нет. */
const REASON_CRITERIA_MISSING = 'criteria_missing';

/** Причина отказа §5.2: дифф больше лимита (код 4). */
const REASON_DIFF_TOO_LARGE = 'diff_too_large';

/** Подкоманды CLI. */
const COMMANDS = Object.freeze(['criteria', 'packet']);

/** Имена файлов внутри `evidence/`. */
const EVIDENCE_FILES = Object.freeze({
  issue: 'issue.md',
  criteria: 'criteria.md',
  diff: 'diff.patch',
  gates: 'gates.json',
  qaWeb: 'qa-web.json',
});

/** Подкаталог логов гейтов внутри `evidence/`. */
const GATES_LOGS_DIR = 'gates';

/** Заголовок секции формы: ровно три решётки и заголовок до конца строки. */
const SECTION_HEADER = /^###[ \t]+(.*)$/;

/** Элемент списка: `- `, `* `, `1.`; содержимое — остаток строки. */
const LIST_ITEM = /^[ \t]*(?:[-*]|\d+\.)[ \t]+(.*)$/;

/** Чекбокс в начале элемента списка: `[ ]`, `[x]`, `[X]`. */
const CHECKBOX = /^\[[ xX]\][ \t]*(.*)$/;

/**
 * Непустая строка после обрезки пробелов.
 * @param {unknown} value
 * @returns {boolean}
 */
function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * @typedef {object} Criterion
 * @property {string} id `C1`, `C2`, …
 * @property {string} text формулировка критерия
 */

/**
 * @typedef {object} IssueSection
 * @property {string} title заголовок секции без `###`
 * @property {string} text текст секции без краевых пробелов
 */

/**
 * @typedef {object} CriteriaExtraction
 * @property {boolean} ok критерии извлечены
 * @property {string|null} reason причина отказа (`criteria_missing`)
 * @property {string|null} detail пояснение для stderr
 * @property {string|null} section использованная секция формы
 * @property {string|null} template шаблон формы: `feature`, `task` или `bug`
 * @property {Criterion[]} criteria пункты `C1…Cn`
 */

/**
 * Секции `### <заголовок>` тела issue. Секция продолжается до следующего заголовка
 * того же уровня; при повторе заголовка используется первая секция (порядок формы).
 * @param {string} body тело issue
 * @returns {IssueSection[]}
 */
export function parseSections(body) {
  if (typeof body !== 'string') throw new TypeError('parseSections: ожидается строка');

  /** @type {{ title: string, lines: string[] }[]} */
  const sections = [];
  /** @type {{ title: string, lines: string[] }|null} */
  let current = null;

  for (const line of body.split('\n')) {
    const header = SECTION_HEADER.exec(line);
    if (header !== null) {
      current = { title: header[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current !== null) current.lines.push(line);
  }

  return sections.map((section) => ({
    title: section.title,
    text: section.lines.join('\n').trim(),
  }));
}

/**
 * Поле формы, оставленное пустым: `_No response_` (регистр не важен) или пустая строка.
 * @param {string} text
 * @returns {boolean}
 */
function isNoResponse(text) {
  const normalized = text.trim().toLowerCase();
  return normalized === '' || normalized === EMPTY_FIELD.toLowerCase();
}

/**
 * Элементы списка секции: маркер (`- `, `* `, `1.`) и чекбокс срезаются, формулировка
 * сохраняется дословно. Пустые пункты и `_No response_` в списке не считаются критериями.
 *
 * Строки без маркера — продолжение текущего пункта: они присоединяются к формулировке
 * через один пробел, пока не встретится следующий маркер, пустая строка или конец текста.
 * Пустая строка закрывает пункт, поэтому абзац после списка критерием не становится,
 * а многострочный пункт остаётся одним критерием.
 * @param {string} text текст секции
 * @returns {string[]}
 */
export function parseListItems(text) {
  if (typeof text !== 'string') throw new TypeError('parseListItems: ожидается строка');

  /** @type {string[]} */
  const items = [];
  /** @type {number|null} индекс пункта, к которому относится продолжение */
  let open = null;

  for (const line of text.split('\n')) {
    const match = LIST_ITEM.exec(line);
    if (match !== null) {
      const checkbox = CHECKBOX.exec(match[1]);
      const value = (checkbox === null ? match[1] : checkbox[1]).trim();
      if (isNoResponse(value)) {
        // Пункт-заглушка не становится критерием, и продолжение к нему не относится.
        open = null;
        continue;
      }
      items.push(value);
      open = items.length - 1;
      continue;
    }

    const continuation = line.trim();
    if (continuation === '') {
      open = null;
      continue;
    }
    // Строки до первого пункта — проза секции: критерием они не становятся.
    if (open === null) continue;
    items[open] = `${items[open]} ${continuation}`;
  }

  return items;
}

/**
 * Приведение текста к одной строке: пробельные последовательности, включая переводы
 * строк, становятся одним пробелом. Нужно только для критерия из прозы bug-issue:
 * в `criteria.md` каждый пункт занимает одну строку (`- C1: …`).
 * @param {string} text
 * @returns {string}
 */
function singleLine(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Есть ли у issue метка `type:bug`. Метки `gh` отдаёт строками или объектами `{ name }`.
 * @param {unknown} labels
 * @returns {boolean}
 */
function isBugIssue(labels) {
  if (!Array.isArray(labels)) return false;

  return labels.some((label) => {
    if (typeof label === 'string') return label === BUG_LABEL;
    if (typeof label !== 'object' || label === null) return false;
    return /** @type {{ name?: unknown }} */ (label).name === BUG_LABEL;
  });
}

/**
 * Отказ извлечения критериев (§5.4).
 * @param {string} detail
 * @returns {CriteriaExtraction}
 */
function criteriaMissing(detail) {
  return {
    ok: false,
    reason: REASON_CRITERIA_MISSING,
    detail,
    section: null,
    template: null,
    criteria: [],
  };
}

/**
 * Извлекает критерии приёмки из issue (docs/orchestrator-core.md §5.4). Чистая функция:
 * вход — `{ title, body, labels }` в форме `gh issue view --json title,body,labels`.
 * Порядок секций зависит от метки `type:bug`; для bug без списка критерием становится
 * весь текст секции `Ожидаемый результат`.
 * @param {{ body?: unknown, labels?: unknown }} issue
 * @returns {CriteriaExtraction}
 */
export function extractCriteria(issue) {
  const body = typeof issue.body === 'string' ? issue.body : '';
  const sections = parseSections(body);

  const priority = isBugIssue(issue.labels)
    ? [SECTIONS.bug, SECTIONS.feature, SECTIONS.task]
    : [SECTIONS.feature, SECTIONS.task, SECTIONS.bug];

  /** @type {IssueSection|undefined} */
  let picked;
  for (const title of priority) {
    picked = sections.find((section) => section.title === title);
    if (picked !== undefined) break;
  }

  if (picked === undefined) {
    return criteriaMissing(
      `в теле issue нет секции критериев («${SECTIONS.feature}», «${SECTIONS.task}», «${SECTIONS.bug}»)`,
    );
  }
  if (isNoResponse(picked.text)) {
    return criteriaMissing(`секция «${picked.title}» пуста (${EMPTY_FIELD})`);
  }

  const items = parseListItems(picked.text);
  if (items.length === 0) {
    // Форма bug критериев не содержит: проза «Ожидаемого результата» — единственный C1.
    if (picked.title !== SECTIONS.bug) {
      return criteriaMissing(`в секции «${picked.title}» нет элементов списка`);
    }
    const text = singleLine(picked.text);
    if (text === '') return criteriaMissing(`секция «${picked.title}» пуста`);
    items.push(text);
  }

  return {
    ok: true,
    reason: null,
    detail: null,
    section: picked.title,
    template: TEMPLATE_BY_SECTION[picked.title] ?? null,
    criteria: items.map((text, index) => ({ id: `C${index + 1}`, text })),
  };
}

/**
 * `evidence/issue.md`: заголовок issue и тело дословно.
 * @param {string} title
 * @param {string} body
 * @returns {string}
 */
export function renderIssue(title, body) {
  const text = `# ${title}\n\n${body}`;
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * `evidence/criteria.md`: заголовок, источник (секция и шаблон) и пункты `C1…Cn`
 * в строчном виде — по строке на критерий, чтобы id однозначно читались оценщиком.
 * @param {{ section: string, template: string|null, criteria: Criterion[] }} extraction
 * @returns {string}
 */
export function renderCriteria({ section, template, criteria }) {
  const source =
    template === null ? `секция «${section}»` : `секция «${section}» (шаблон ${template})`;
  const lines = [
    '# Критерии приёмки',
    '',
    `Источник: ${source}.`,
    '',
    ...criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}`),
    '',
  ];
  return lines.join('\n');
}

/**
 * Число изменённых строк диффа: добавления и удаления внутри ханков. Разбор структурный,
 * как в `git.addedLines`: заголовки файлов (`diff --git`, `index`, `---`, `+++`,
 * `new file mode`, `Binary files`) и контекст не считаются, `\ No newline at end of file`
 * тоже. Поэтому лимит §5.2 считается по фактическим изменениям, а не по размеру патча.
 * @param {string} diff вывод `git diff`
 * @returns {number}
 */
export function countChangedLines(diff) {
  if (typeof diff !== 'string') throw new TypeError('countChangedLines: ожидается строка');

  let inHunk = false;
  let count = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('\\')) continue;
    // Внутри ханка `+++`/`---` — это добавление/удаление строки, начинающейся с `++`/`--`.
    if (line.startsWith('+') || line.startsWith('-')) count += 1;
  }

  return count;
}

/**
 * Проверка лимитов диффа (§5.2): изменённые строки и байты сырого диффа. Ровно на границе
 * превышения нет — `diff_too_large` начинается со следующего значения.
 * @param {string} diff сырой вывод `git diff`
 * @param {{ maxDiffLines: number, maxDiffBytes: number }} [limits]
 * @returns {{ lines: number, bytes: number, tooLarge: boolean }}
 */
export function diffLimits(diff, limits = LIMITS) {
  const lines = countChangedLines(diff);
  const bytes = Buffer.byteLength(diff, 'utf8');

  return {
    lines,
    bytes,
    tooLarge: lines > limits.maxDiffLines || bytes > limits.maxDiffBytes,
  };
}

/**
 * Лежит ли путь внутри каталога (равенство считается «внутри»).
 * @param {string} parent каталог
 * @param {string} child проверяемый путь
 * @returns {boolean}
 */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Канонический абсолютный путь. Для существующего пути — `realpathSync`; для ещё не
 * созданного — канонический ближайший существующий предок плюс остаток. Так ограничения
 * на запись не зависят от того, создан ли каталог, а символическая ссылка на любом
 * уровне не обходит проверку.
 * @param {string} path
 * @returns {string}
 */
function canonicalPath(path) {
  const absolute = resolve(path);
  /** @type {string[]} */
  const rest = [];

  let head = absolute;
  for (;;) {
    try {
      const real = realpathSync(head);
      return rest.length === 0 ? real : join(real, ...[...rest].reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return absolute;
      rest.push(basename(head));
      head = parent;
    }
  }
}

/**
 * Проверка каталога цикла на право записи (§4: скрипты пишут только в `.pi/artifacts/<…>/`).
 * Каталог вне корня репозитория разрешён: так работают тесты и ручной smoke на временных
 * git-репозиториях. Каталог внутри корня обязан лежать в `<root>/.pi/artifacts/`.
 * @param {string} dir каталог цикла
 * @param {string} root корень репозитория
 * @returns {void}
 */
function assertWritableDir(dir, root) {
  const canonicalRoot = canonicalPath(root);
  const canonicalDir = canonicalPath(dir);
  if (!isInside(canonicalRoot, canonicalDir)) return;

  const allowed = artifactsDir(root);
  if (isInside(canonicalPath(allowed), canonicalDir)) return;

  throw new Error(
    `--dir: каталог внутри репозитория должен лежать в ${allowed}, получено: ${dir} (§4) ` +
      `(корень репозитория: ${canonicalRoot})`,
  );
}

/**
 * Путь лога гейта внутри каталога цикла. Лог из `gates.<n>.json` — данные, поэтому
 * абсолютные пути и выход за каталог цикла отбрасываются: пакет не должен тянуть файлы
 * из репозитория или из `/`.
 *
 * Проверка идёт по каноническим путям (`realpathSync` каталога цикла и найденного файла):
 * символическая ссылка на файл вне каталога цикла (например, на `.env.local`) не должна
 * превращаться в свидетельство. Несуществующий файл — пропуск, как и раньше.
 * @param {string} dir каталог цикла
 * @param {unknown} log относительный путь лога из документа гейтов
 * @returns {string|null} канонический путь или `null`, если путь недопустим
 */
function logPathInside(dir, log) {
  if (typeof log !== 'string' || log.trim() === '') return null;

  const base = resolve(dir);
  const file = resolve(base, log);
  if (!isInside(base, file) || file === base) return null;
  if (!existsSync(file)) return null;

  let canonicalBase;
  try {
    canonicalBase = realpathSync(base);
  } catch {
    return null;
  }

  let canonicalFile;
  try {
    // `realpathSync` разрешает все ссылки в пути, а не только последнюю.
    canonicalFile = realpathSync(file);
  } catch {
    return null;
  }

  if (!isInside(canonicalBase, canonicalFile)) return null;
  return canonicalFile;
}

/**
 * Читаемое представление артефакта: два пробела и завершающий перевод строки.
 * @param {unknown} data
 * @returns {string}
 */
function serializeArtifact(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/**
 * Читает обязательный JSON-артефакт и проверяет схему. Отсутствие или порча `state.json`
 * и `gates.<n>.json` — отказ (код 2): без них пакет не собрать.
 * @param {string} file
 * @param {(doc: unknown) => { ok: boolean, errors: string[] }} validator
 * @param {string} label имя артефакта для сообщения
 * @returns {Record<string, any>}
 */
function readRequiredJson(file, validator, label) {
  /** @type {unknown} */
  let doc;
  try {
    doc = readJson(file);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: не читается как JSON (${file}): ${reason}`, { cause: error });
  }

  const result = validator(doc);
  if (!result.ok) {
    throw new Error(`${label}: схема нарушена (${file}):\n${result.errors.join('\n')}`);
  }
  return /** @type {Record<string, any>} */ (doc);
}

/**
 * Читает `issue.json`, подготовленный супервизором: `gh issue view N --json
 * title,body,labels`. Валидация защитная — файл пишет не этот скрипт.
 * @param {string} file
 * @returns {{ title: string, body: string, labels: unknown }}
 */
function readIssue(file) {
  /** @type {unknown} */
  let doc;
  try {
    doc = readJson(file);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`issue.json: не читается как JSON (${file}): ${reason}`, { cause: error });
  }

  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error(`issue.json: ожидается объект с title, body и labels (${file})`);
  }

  /** @type {Record<string, unknown>} */
  const issue = doc;
  if (!isText(issue.title)) {
    throw new Error(`issue.json: поле title отсутствует или пустое (${file})`);
  }
  if (issue.body !== undefined && typeof issue.body !== 'string') {
    throw new Error(`issue.json: поле body должно быть строкой (${file})`);
  }
  if (issue.labels !== undefined && !Array.isArray(issue.labels)) {
    throw new Error(`issue.json: поле labels должно быть массивом (${file})`);
  }

  return {
    title: /** @type {string} */ (issue.title).trim(),
    body: typeof issue.body === 'string' ? issue.body : '',
    labels: issue.labels,
  };
}

/**
 * @typedef {object} EvidenceFile
 * @property {string} path путь относительно каталога цикла (`evidence/…`)
 * @property {string} text содержимое файла
 */

/**
 * @typedef {object} PacketPlan
 * @property {boolean} tooLarge дифф больше лимита (§5.2)
 * @property {number} lines изменённых строк сырого диффа
 * @property {number} bytes размер сырого диффа
 * @property {string} baseSha разрешённый полный sha базы диффа
 * @property {number} iteration номер итерации цикла
 * @property {EvidenceFile[]} files файлы пакета
 */

/**
 * Сборка пакета `evidence/` в памяти. Дифф строится от базы цикла, untracked-файлы
 * предварительно делаются видимыми через `intentToAddUntracked` (§4). Ничего не пишется:
 * CLI записывает файлы только после успешной сборки (при `diff_too_large` — не пишет вовсе).
 * @param {{ dir: string, root: string, base?: string|null }} options
 * @returns {PacketPlan}
 */
function buildPacket({ dir, root, base = null }) {
  const state = readRequiredJson(join(dir, FIXED_NAMES.state), validateState, FIXED_NAMES.state);
  const iteration = /** @type {number} */ (state.iteration);
  const names = iterNames(iteration);

  const gatesFile = join(dir, names.gates);
  const gatesText = readFileSync(gatesFile, 'utf8');
  const gates = readRequiredJson(gatesFile, validateGates, names.gates);

  const evidenceDir = join(dir, FIXED_NAMES.evidenceDir);
  if (!existsSync(join(evidenceDir, EVIDENCE_FILES.criteria))) {
    throw new Error(
      `${FIXED_NAMES.evidenceDir}/${EVIDENCE_FILES.criteria}: критерии не собраны, сначала ` +
        'подкоманда criteria',
    );
  }

  // Приоритет базы: явный `--base` → база прогона гейтов → база цикла. База гейтов
  // сохраняет консистентность с `gates.<n>.json` (его `base_sha` пишет cycle-gates).
  const baseRev = base ?? gates.base_sha ?? state.base_sha;
  const baseShaValue = resolveBaseSha({ base: baseRev, cwd: root });

  // §4: untracked-файлы должны быть видны в диффе, иначе новые файлы не попадут в пакет.
  intentToAddUntracked({ cwd: root });
  const rawDiff = diffFromBase(baseShaValue, { cwd: root });

  const limits = diffLimits(rawDiff);
  if (limits.tooLarge) {
    return {
      tooLarge: true,
      lines: limits.lines,
      bytes: limits.bytes,
      baseSha: baseShaValue,
      iteration,
      files: [],
    };
  }

  /** @type {EvidenceFile[]} */
  const files = [
    // Маскирование не меняет структуру: строки и `@@`-заголовки остаются прежними.
    { path: `${FIXED_NAMES.evidenceDir}/${EVIDENCE_FILES.diff}`, text: redactLog(rawDiff) },
    // `gates.json` — байт-в-байт копия документа гейтов: оценщик сверяет статусы.
    { path: `${FIXED_NAMES.evidenceDir}/${EVIDENCE_FILES.gates}`, text: gatesText },
  ];

  for (const entry of gates.gates) {
    if (entry.status !== 'fail' || entry.log === null) continue;
    const logFile = logPathInside(dir, entry.log);
    if (logFile === null || !existsSync(logFile)) continue;

    const text = redactLog(tail(logFile, LIMITS.evidenceTailLines));
    files.push({
      path: `${FIXED_NAMES.evidenceDir}/${GATES_LOGS_DIR}/${entry.id}.${iteration}.log`,
      text: text === '' ? '' : `${text}\n`,
    });
  }

  const qaFile = join(dir, FIXED_NAMES.qaWeb);
  if (existsSync(qaFile)) {
    // Повреждённые сырые данные QA нельзя молча выбросить из пакета: это скрыло бы
    // свидетельство. Битый файл — отказ (код 2), как у cycle-decide.
    const qa = readRequiredJson(qaFile, validateQaWeb, FIXED_NAMES.qaWeb);
    files.push({
      path: `${FIXED_NAMES.evidenceDir}/${EVIDENCE_FILES.qaWeb}`,
      text: serializeArtifact(normalizeDoc(redactQa(qa))),
    });
  }

  return {
    tooLarge: false,
    lines: limits.lines,
    bytes: limits.bytes,
    baseSha: baseShaValue,
    iteration,
    files,
  };
}

/**
 * Запись файлов пакета: каталоги создаются по месту, каждый файл — атомарно.
 * @param {string} dir каталог цикла
 * @param {EvidenceFile[]} files
 * @returns {void}
 */
function writeEvidenceFiles(dir, files) {
  for (const file of files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeTextAtomic(target, file.text);
  }
}

/**
 * Подкоманда `criteria`: извлечение критериев и запись `evidence/issue.md` и
 * `evidence/criteria.md`. При `criteria_missing` файлы не пишутся, в stdout — строка JSON
 * с причиной, код 2.
 * @param {{ dir: string, issueJson: string }} options
 * @returns {number} код выхода
 */
function runCriteria({ dir, issueJson }) {
  const issue = readIssue(issueJson);
  const extraction = extractCriteria(issue);

  if (!extraction.ok) {
    process.stdout.write(
      `${JSON.stringify(normalizeDoc({ command: 'criteria', reason: extraction.reason }))}\n`,
    );
    process.stderr.write(
      `cycle-evidence: ${extraction.reason}: ${extraction.detail} (${issueJson})\n`,
    );
    return 2;
  }

  const evidenceDir = join(dir, FIXED_NAMES.evidenceDir);
  mkdirSync(evidenceDir, { recursive: true });
  writeTextAtomic(join(evidenceDir, EVIDENCE_FILES.issue), renderIssue(issue.title, issue.body));
  writeTextAtomic(
    join(evidenceDir, EVIDENCE_FILES.criteria),
    renderCriteria({
      section: /** @type {string} */ (extraction.section),
      template: extraction.template,
      criteria: extraction.criteria,
    }),
  );

  const summary = {
    command: 'criteria',
    criteria: extraction.criteria.map((criterion) => criterion.id),
    files: [
      `${FIXED_NAMES.evidenceDir}/${EVIDENCE_FILES.issue}`,
      `${FIXED_NAMES.evidenceDir}/${EVIDENCE_FILES.criteria}`,
    ],
    section: extraction.section,
    template: extraction.template,
  };
  process.stdout.write(`${JSON.stringify(normalizeDoc(summary))}\n`);
  return 0;
}

/**
 * Подкоманда `packet`: сборка `evidence/` для оценщика. При `diff_too_large` файлы не
 * пишутся, в stdout — строка JSON с причиной и размерами, код 4.
 * @param {{ dir: string, root: string, base: string|null }} options
 * @returns {number} код выхода
 */
function runPacket({ dir, root, base }) {
  const packet = buildPacket({ dir, root, base });

  if (packet.tooLarge) {
    const doc = {
      command: 'packet',
      reason: REASON_DIFF_TOO_LARGE,
      lines: packet.lines,
      bytes: packet.bytes,
    };
    process.stdout.write(`${JSON.stringify(normalizeDoc(doc))}\n`);
    process.stderr.write(
      `cycle-evidence: ${REASON_DIFF_TOO_LARGE}: ${packet.lines} строк, ${packet.bytes} байт ` +
        `(лимит ${LIMITS.maxDiffLines} строк, ${LIMITS.maxDiffBytes} байт)\n`,
    );
    return 4;
  }

  writeEvidenceFiles(dir, packet.files);

  const summary = {
    command: 'packet',
    base_sha: packet.baseSha,
    bytes: packet.bytes,
    files: packet.files.map((file) => file.path),
    iteration: packet.iteration,
    lines: packet.lines,
  };
  process.stdout.write(`${JSON.stringify(normalizeDoc(summary))}\n`);
  return 0;
}

/**
 * Разбирает аргументы командной строки: подкоманда и её опции. Любой мусор, в том числе
 * опция другой подкоманды, — ошибка использования (код 2).
 * @param {string[]} argv аргументы без `node` и имени скрипта
 * @returns {{ command: 'criteria'|'packet', dir: string|null, issueJson: string|null, base: string|null }}
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === undefined) {
    throw new Error(`не задана подкоманда: ${COMMANDS.join(' | ')}`);
  }
  if (!COMMANDS.includes(command)) {
    throw new Error(`неизвестная подкоманда: ${command} (ожидается ${COMMANDS.join(' | ')})`);
  }

  /** @type {string|null} */
  let dir = null;
  /** @type {string|null} */
  let issueJson = null;
  /** @type {string|null} */
  let base = null;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const value = rest[index + 1];

    if (arg === '--dir') {
      if (!isText(value) || value.startsWith('--')) {
        throw new Error('--dir: ожидается путь к каталогу цикла');
      }
      dir = value;
      index += 1;
      continue;
    }
    if (arg === '--issue-json' && command === 'criteria') {
      if (!isText(value) || value.startsWith('--')) {
        throw new Error('--issue-json: ожидается путь к файлу вывода gh issue view');
      }
      issueJson = value;
      index += 1;
      continue;
    }
    if (arg === '--base' && command === 'packet') {
      if (!isText(value) || value.startsWith('--')) {
        throw new Error('--base: ожидается sha или имя ссылки');
      }
      base = value;
      index += 1;
      continue;
    }
    throw new Error(`неизвестный аргумент: ${arg}`);
  }

  return {
    command: /** @type {'criteria'|'packet'} */ (command),
    dir,
    issueJson,
    base,
  };
}

/**
 * Точка входа CLI. Пишет только в каталог цикла (`evidence/`), а каталог внутри
 * репозитория обязан лежать в `.pi/artifacts/` (`assertWritableDir`). Единственный вывод —
 * строка JSON в stdout, диагностика — в stderr.
 * @returns {void}
 */
function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const root = repoRoot();
    const dir = args.dir === null ? findActiveCycle() : resolve(args.dir);
    assertWritableDir(dir, root);

    if (args.command === 'criteria') {
      const issueJson =
        args.issueJson === null ? join(dir, FIXED_NAMES.issue) : resolve(args.issueJson);
      process.exitCode = runCriteria({ dir, issueJson });
      return;
    }

    process.exitCode = runPacket({ dir, root, base: args.base });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cycle-evidence: ${message}\n`);
    process.exitCode = 2;
  }
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
