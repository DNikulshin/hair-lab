#!/usr/bin/env node
/**
 * Тело PR по артефактам цикла (docs/orchestrator-core.md §5.7, issue #158, задача T6b).
 *
 *   node scripts/cycle-pr-body.mjs --dir D [--draft-escalation]
 *
 * Скрипт собирает тело PR по `.github/PULL_REQUEST_TEMPLATE.md` из фактов цикла и печатает
 * его в stdout. На диск ничего не пишется: PR открывает супервизор (Приложение B, этап
 * `PROCEED*`), а скрипт остаётся чистым сборщиком текста.
 *
 * **Входы.** Обязательные: `state.json`, `gates.<n>.json`, `review.<n>.json`,
 * `evaluation.<n>.json`, `decision.<n>.json`, `evidence/criteria.md` — `n` берётся из
 * `state.iteration` (`iterNames`). Необязательные: `code-report.<n>.md` / `plan.<n>.md`
 * (источник пунктов «Что сделано»), `followups.md` (раздел «Вне скоупа») и `escalation.json`
 * (баннер при `--draft-escalation`). Отсутствие необязательного файла — не ошибка, раздел
 * остаётся заглушкой; битый или отсутствующий обязательный — код 2: без него разделы PR
 * были бы выдуманными. Перед сборкой каждый документ проходит валидатор схемы из
 * `lib/cycle/validate.mjs` — своего разбора структуры здесь нет.
 *
 * **Структура.** Секции шаблона идут в его порядке: «Что сделано» (пункты из раздела
 * «Что сделано»/«Что изменено» отчёта `code`, #249)
 * прохода и обязательная строка `Closes #<issue>` из `state.issue`), «Как проверять»
 * (что осталось проверить руками по исходам гейтов), «Проверки» (чекбоксы из
 * `gates.<n>.json`: `- [x]` только у `pass`/`skipped`), «Независимая оценка» (§5.7:
 * вердикты ревью и оценки рядом, таблица критериев `C1…Cn` в порядке `criteria.md`,
 * `partial`/`unverified`, замечания ревью, при `PROCEED_WITH_UNVERIFIED` — блок
 * «не проверено» с чекбоксами для владельца), «Риски» (пункты шаблона: их отмечает
 * человек, скрипт их не угадывает), «Вне скоупа» (пункты `followups.md`).
 * С `--draft-escalation` в начало добавляется баннер: причина, пояснение,
 * `draft_pr_allowed` и открытые замечания из `escalation.json`.
 *
 * **Дедупликация «не проверено».** Один и тот же факт приходит из двух артефактов: `cycle-decide`
 * пишет в `decision.unverified[]` строку `evaluation unverified: <what>`, а
 * `evaluation.unverified[]` хранит `what` и `why`. В блоке «не проверено» пункт печатается
 * один раз — в более полной формулировке (`<what> — <why>`); сравнение идёт по
 * нормализованной форме без префикса источника (#204).
 *
 * **Ссылки критериев.** В колонке «Свидетельство» — первая *разрешаемая* ссылка из
 * `evaluation.criteria[].evidence` (`resolveRef`: файл существует, строка в файле, гейт есть
 * в `gates.<n>.json`). Если не разрешается ни одна, показывается первая ссылка как есть, а
 * при пустом `evidence` — примечание критерия: предпочтение отдаётся проверяемому
 * свидетельству, но само свидетельство не теряется. Неразрешённая ссылка — свободный текст
 * из артефакта, поэтому маскируется так же, как остальной текст (§5.4): `evidence[]` —
 * произвольная непустая строка, а тело PR публично.
 *
 * **Полнота оценивания.** Набор id в `evaluation.criteria` обязан покрывать критерии
 * `evidence/criteria.md`: иначе строка таблицы осталась бы без статуса. Пропуск — ошибка
 * сборки (код 2), а не ячейка `—`: таблица статусов в PR не должна быть неполной.
 *
 * **Детерминизм.** Ни времени, ни случайности, ни зависимости от порядка ключей объектов
 * входа: гейты сортируются по таблице §5.5 (`GATES`), критерии — по `criteria.md`, списки —
 * по порядку источника. Два запуска на одних входах дают побайтно одинаковый вывод.
 *
 * **ПДн.** Тело PR публично, а артефакты цикла — нет. Любой свободный текст из них
 * (`summary` и `id` находок, ссылка и `note` критерия, `detail` и `open_items` эскалации,
 * `unverified` оценщика и решения, пункты `followups.md` и «Что сделано») проходит через
 * `redactLog`: телефоны, e-mail и секреты становятся `[phone]`/`[email]`/`[secret]`.
 * Формулировки критериев берутся из issue дословно (issue публичен), сырые логи и QA не
 * копируются.
 *
 * **Коды выхода.** `0` — тело собрано; `2` — ошибка использования или внутренняя (нет
 * каталога или обязательного артефакта, битый JSON, нарушена схема, критерий из
 * `criteria.md` остался без статуса, мусор в аргументах). Диагностика — в stderr без
 * стектрейса. Shebang нужен: файл запускается напрямую.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GATES } from './lib/cycle/config.mjs';
import { readJson } from './lib/cycle/io.mjs';
import { FIXED_NAMES, findActiveCycle, iterNames, repoRoot } from './lib/cycle/paths.mjs';
import { redactLog } from './lib/cycle/redact.mjs';
import { resolveRef } from './lib/cycle/refs.mjs';
import {
  validateDecision,
  validateEscalation,
  validateEvaluation,
  validateGates,
  validateReview,
  validateState,
} from './lib/cycle/validate.mjs';

/** Критерии приёмки оценщика: путь задан §5.1 (`evidence/criteria.md`). */
const CRITERIA_FILE = 'criteria.md';

/** Сколько пунктов «Что сделано» брать из артефактов прохода (шаблон: 1–3). */
const SUMMARY_LIMIT = 3;

/** Предел длины свободного текста в ячейке таблицы: простыни в PR не читаются. */
const MAX_CELL = 160;

/** Положительный вердикт ревью (Приложение A). */
const REVIEW_POSITIVE = 'merge-ready';

/** Вердикты оценки, не требующие доработки (Приложение A). */
const EVALUATION_POSITIVE = Object.freeze(['ACCEPT', 'ACCEPT_WITH_FOLLOWUPS']);

/** Действие решения, добавляющее блок «не проверено» (§5.7). */
const PROCEED_WITH_UNVERIFIED = 'PROCEED_WITH_UNVERIFIED';

/** Порядок гейтов в таблице §5.5: строки PR идут в нём, а не в порядке файла. */
const GATE_ORDER = new Map(GATES.map((gate, index) => [gate.id, index]));

/** Пункты раздела «Риски» шаблона PR: их отмечает человек, скрипт их не выводит. */
const RISK_ITEMS = Object.freeze([
  'Есть миграция БД (expand/contract, откат описан)',
  'Меняются контракты (только обратно совместимо)',
  'Затрагиваются персональные данные или авторизация',
  'Нужны новые переменные окружения / секреты',
  'Ничего из перечисленного',
]);

/** Элемент списка markdown: `- `, `* `, `1.`; содержимое — остаток строки. */
const LIST_ITEM = /^[ \t]*(?:[-*]|\d+\.)[ \t]+(.*)$/;

/** Чекбокс в начале элемента списка: `[ ]`, `[x]`, `[X]`. */
const CHECKBOX = /^\[[ xX]\][ \t]*(.*)$/;

/** Заголовок markdown: закрывает предыдущий пункт списка. */
const HEADING = /^#{1,6}[ \t]/;

/** Заголовок любого уровня с текстом: используется при разборе разделов отчёта. */
const SECTION_HEADING = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/**
 * Раздел отчёта `code`, из которого берутся пункты «Что сделано» (#249). Запасного варианта
 * «первый раздел после «Файлы»» нет (#267): в реальных отчётах сразу за «Файлы» идут
 * «Проверки», «Не проверено» или «Расхождения с планом», и строки гейтов уезжали в PR как
 * сделанная работа. Нет раздела — заглушка со ссылкой на отчёт (§5.7).
 */
const WHAT_DONE_HEADING = /^что[ \t]+(?:сделано|изменено)(?:[ \t]|$)/i;

/**
 * Префикс источника в `decision.unverified[]`: `cycle-decide` пишет `evaluation unverified: <what>`
 * (§5.6). При сборке тела PR тот же факт приходит и из `evaluation.unverified[]` — префикс
 * снимается при сравнении, иначе один пункт попадает в PR дважды (#204).
 */
const SOURCE_PREFIX = /^(?:evaluation|review|decision)[ \t]+unverified:[ \t]*/iu;

/** Строка `evidence/criteria.md`: строчный контракт `- C1: формулировка` (§5.4). */
const CRITERION_LINE = /^-[ \t]+(C[1-9]\d*):[ \t]*(.*)$/;

/**
 * Непустая строка после обрезки пробелов.
 * @param {unknown} value
 * @returns {boolean}
 */
function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Свободный текст артефакта для публичного PR: маскируется по §5.4.
 * Нестроковое значение приводится к строке — иначе маскировать было бы нечего.
 * @param {unknown} value
 * @returns {string}
 */
function redacted(value) {
  return redactLog(typeof value === 'string' ? value : String(value));
}

/**
 * Текст в одну строку: пробельные последовательности, включая переводы строк, — один пробел.
 * @param {string} text
 * @returns {string}
 */
function singleLine(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Ячейка markdown-таблицы: одна строка, ограничение длины, экранированный `|`.
 * @param {string} text
 * @returns {string}
 */
function cell(text) {
  const value = singleLine(text);
  const shortened = value.length <= MAX_CELL ? value : `${value.slice(0, MAX_CELL - 1).trimEnd()}…`;
  return shortened.replace(/\|/g, '\\|');
}

/**
 * Нормализованная форма пункта «не проверено»: без префикса источника и без разницы
 * в регистре/пробелах. Сравнение по ней, а не по сырому тексту — иначе формулировки
 * одного и того же факта из двух артефактов считаются разными.
 * @param {string} text
 * @returns {string}
 */
function unverifiedKey(text) {
  return singleLine(text).replace(SOURCE_PREFIX, '').toLowerCase();
}

/**
 * Один ли это факт в двух формулировках: точное совпадение или более короткая версия —
 * начало более полной на границе слова (`<what>` против `<what> — <why>`).
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function sameUnverified(left, right) {
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  if (!longer.startsWith(shorter)) return false;
  return /^[\s—–-]/u.test(longer.slice(shorter.length));
}

/**
 * Дедупликация пунктов «не проверено» из `decision.unverified[]` и
 * `evaluation.unverified[]`. Из пары остаётся более полная формулировка, позиция — первого
 * вхождения (порядок артефактов сохраняется, вывод детерминирован).
 * @param {string[]} items
 * @returns {string[]}
 */
export function dedupeUnverified(items) {
  if (!Array.isArray(items)) throw new TypeError('dedupeUnverified: ожидается массив');

  /** @type {{ key: string, text: string }[]} */
  const kept = [];
  for (const item of items) {
    if (!isText(item)) continue;
    const text = singleLine(item);
    const key = unverifiedKey(text);
    const index = kept.findIndex((entry) => sameUnverified(entry.key, key));
    if (index === -1) kept.push({ key, text });
    else if (text.length > kept[index].text.length) kept[index] = { key, text };
  }

  return kept.map((entry) => entry.text);
}

/**
 * Элементы markdown-списка. Строки без маркера — продолжение текущего пункта (пункт
 * остаётся одной строкой); пустая строка или заголовок закрывают пункт.
 * Локальная реализация, а не `parseListItems` из `cycle-evidence.mjs`: тот разбирает
 * тело issue и тянет за собой весь CLI оценщика, а здесь нужны только пункты `.md`.
 * @param {string} markdown
 * @returns {string[]}
 */
export function listItems(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('listItems: ожидается строка');

  /** @type {string[]} */
  const items = [];
  /** @type {number|null} индекс пункта, к которому относится продолжение */
  let open = null;

  for (const line of markdown.split(/\r?\n/)) {
    const match = LIST_ITEM.exec(line);
    if (match !== null) {
      const checkbox = CHECKBOX.exec(match[1]);
      const value = (checkbox === null ? match[1] : checkbox[1]).trim();
      if (value === '') {
        open = null;
        continue;
      }
      items.push(value);
      open = items.length - 1;
      continue;
    }

    const continuation = line.trim();
    if (continuation === '' || HEADING.test(continuation)) {
      open = null;
      continue;
    }
    // Проза до первого пункта критерием не становится, после пункта — его продолжение.
    if (open === null) continue;
    items[open] = `${items[open]} ${continuation}`;
  }

  return items;
}

/**
 * @typedef {object} Criterion
 * @property {string} id `C1`, `C2`, …
 * @property {string} text формулировка критерия
 */

/**
 * Критерии из `evidence/criteria.md` в её порядке: по строке `- C1: формулировка` на
 * критерий (формат `renderCriteria` в `cycle-evidence.mjs`). Пустой результат — ошибка:
 * без критериев таблица PR была бы пустой подменой.
 * @param {string} markdown
 * @returns {Criterion[]}
 */
export function parseCriteria(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('parseCriteria: ожидается строка');

  /** @type {Criterion[]} */
  const criteria = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = CRITERION_LINE.exec(line.trim());
    if (match !== null) criteria.push({ id: match[1], text: match[2].trim() });
  }
  return criteria;
}

/**
 * Пустая ячейка таблицы: так помечается отсутствующее значение, а не выдуманное.
 * @returns {string}
 */
function emptyCell() {
  return '—';
}

/**
 * Ссылка на свидетельство для ячейки таблицы: первая разрешаемая из `evidence[]`,
 * иначе первая как есть, иначе примечание критерия. Текст маскируется (§5.4).
 * @param {Record<string, any>} criterion критерий оценки
 * @param {import('./lib/cycle/refs.mjs').RefContext} ctx
 * @returns {string}
 */
function evidenceCell(criterion, ctx) {
  const evidence = Array.isArray(criterion.evidence) ? criterion.evidence : [];
  for (const ref of evidence) {
    if (resolveRef(ref, ctx).ok) return cell(`\`${ref.trim()}\``);
  }
  // Неразрешённая ссылка не прошла ни одну проверку формы, поэтому это свободный текст из
  // вывода агента: маскируется наравне с прочим (§5.4), иначе телефон или e-mail из
  // `evidence[]` попадёт в публичное тело PR.
  if (evidence.length > 0) return cell(`\`${redacted(String(evidence[0]).trim())}\``);
  if (isText(criterion.note)) return cell(redacted(criterion.note));
  return emptyCell();
}

/**
 * Сноска гейта: причина для `not_run`/`skipped`, код выхода для `fail`.
 * @param {Record<string, any>} gate
 * @returns {string} ` (…)` или пустая строка
 */
function gateNote(gate) {
  /** @type {string[]} */
  const parts = [];
  if (gate.status === 'fail' && Number.isInteger(gate.exit)) parts.push(`exit ${gate.exit}`);
  if (isText(gate.reason)) parts.push(gate.reason.trim());
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

/**
 * Гейты в порядке таблицы §5.5; неизвестные id (расширение таблицы) — после известных,
 * по алфавиту: порядок строк не должен зависеть от порядка файла.
 * @param {unknown} value `gates[].gates`
 * @returns {Record<string, any>[]}
 */
export function orderGates(value) {
  const entries = Array.isArray(value)
    ? value.filter((gate) => typeof gate === 'object' && gate !== null)
    : [];
  const known = (gate) => GATE_ORDER.get(gate.id) ?? GATES.length;

  return [...entries].sort((left, right) => {
    const delta = known(left) - known(right);
    if (delta !== 0) return delta;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
}

/**
 * Баннер эскалации (§5.7): причина, пояснение, `draft_pr_allowed` и открытые замечания.
 * @param {Record<string, any>} escalation проверенный `escalation.json`
 * @returns {string}
 */
export function renderEscalationBanner(escalation) {
  /** @type {string[]} */
  const lines = ['> [!WARNING]', `> **Draft PR: эскалация \`${escalation.reason}\`.**`];

  if (isText(escalation.detail)) {
    for (const line of redacted(escalation.detail).split(/\r?\n/)) lines.push(`> ${line.trim()}`);
  }
  lines.push(`> Draft PR разрешён: ${escalation.draft_pr_allowed === true ? 'да' : 'нет'}.`);

  const openItems = Array.isArray(escalation.open_items) ? escalation.open_items : [];
  if (openItems.length > 0) {
    lines.push('>', '> Открытые замечания:', '>');
    for (const item of openItems) lines.push(`> - ${redacted(item)}`);
  }

  return lines.join('\n');
}

/**
 * Пункты разделов markdown. Возвращает разделы в порядке файла: заголовок и его пункты
 * (проза и вложенные заголовки пунктами не становятся). Нужен, чтобы взять пункты
 * конкретного раздела, а не всего отчёта (#249).
 * @param {string} markdown
 * @returns {{ title: string, items: string[] }[]}
 */
export function sections(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('sections: ожидается строка');

  /** @type {{ title: string, items: string[] }[]} */
  const result = [];
  /** @type {{ title: string, items: string[] }|null} */
  let current = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = SECTION_HEADING.exec(line);
    if (heading !== null) {
      current = { title: heading[1], items: [] };
      result.push(current);
      continue;
    }
    if (current === null) continue;

    const match = LIST_ITEM.exec(line);
    if (match === null) continue;
    const checkbox = CHECKBOX.exec(match[1]);
    const value = (checkbox === null ? match[1] : checkbox[1]).trim();
    if (value !== '') current.items.push(value);
  }

  return result;
}

/**
 * Пункты «Что сделано»: первые `SUMMARY_LIMIT` пунктов явного раздела «Что сделано»
 * («Что изменено») из `code-report.<n>.md`, при отсутствии отчёта — из `plan.<n>.md`.
 * Запасного правила «первый раздел после «Файлы»» нет (#267): там обычно стоят «Проверки»,
 * и строки гейтов выдавали себя за работу. Формулировки берутся из артефактов дословно,
 * своих скрипт не придумывает; маскирование (§5.4) применяет `renderPrBody`. Нет такого
 * раздела — нет пунктов: заглушка честнее чужих пунктов из «Расхождений» или «Не проверено».
 * @param {string} dir каталог цикла
 * @param {ReturnType<typeof iterNames>} names имена файлов итерации
 * @returns {string[]}
 */
export function summaryItems(dir, names) {
  const reportPath = join(dir, names.codeReport);
  if (existsSync(reportPath)) {
    const reportSections = sections(readFileSync(reportPath, 'utf8'));
    const explicit = reportSections.find((item) => WHAT_DONE_HEADING.test(item.title));
    if (explicit !== undefined && explicit.items.length > 0) {
      return explicit.items.slice(0, SUMMARY_LIMIT);
    }

    // Никакого запасного раздела: «Проверки», «Не проверено» и «Расхождения с планом»
    // источниками «Что сделано» не являются (#267).
    return [];
  }

  const planPath = join(dir, names.plan);
  if (!existsSync(planPath)) return [];
  const items = listItems(readFileSync(planPath, 'utf8'));
  return items.slice(0, SUMMARY_LIMIT);
}

/**
 * Тело PR целиком. Чистая функция: файлов не читает, время и случайность не использует.
 * @param {{
 *   state: Record<string, any>,
 *   gates: Record<string, any>,
 *   review: Record<string, any>,
 *   evaluation: Record<string, any>,
 *   decision: Record<string, any>,
 *   criteria: Criterion[],
 *   summary: string[],
 *   followups: string[],
 *   escalation: Record<string, any>|null,
 *   root: string,
 * }} inputs
 * @returns {string} тело PR с завершающим переводом строки
 */
export function renderPrBody(inputs) {
  const {
    state,
    gates,
    review,
    evaluation,
    decision,
    criteria,
    summary,
    followups,
    escalation,
    root,
  } = inputs;

  /** @type {Record<string, any>[]} */
  const gateEntries = orderGates(gates.gates);
  /** @type {import('./lib/cycle/refs.mjs').RefContext} */
  const ctx = { root, gates, qa: null };

  /** @type {string[]} */
  const sections = [];

  if (escalation !== null) sections.push(renderEscalationBanner(escalation));

  // Что сделано: пункты из артефактов прохода и обязательная ссылка на issue.
  const doneLines = ['## Что сделано', ''];
  if (summary.length > 0) {
    doneLines.push(...summary.map((item) => `- ${redacted(item)}`), '');
  } else {
    // Пустой раздел честнее чужих пунктов из «Расхождений» или «Не проверено» (#249).
    doneLines.push(
      `Пункты «Что сделано» не найдены в \`${iterNames(state.iteration).codeReport}\`.`,
      '',
    );
  }
  doneLines.push(`Closes #${state.issue}`);
  sections.push(doneLines.join('\n'));

  // Как проверять: что осталось на человека по исходам гейтов.
  const manual = gateEntries.filter((gate) => gate.status !== 'pass' && gate.status !== 'skipped');
  const howLines = ['## Как проверять', ''];
  if (manual.length === 0) {
    howLines.push('Все гейты пройдены или неприменимы: ручных шагов нет.');
  } else {
    howLines.push('Гейты, по которым нужен ручной шаг:', '');
    for (const gate of manual) howLines.push(`- \`${gate.id}\` — ${gate.status}${gateNote(gate)}`);
  }
  sections.push(howLines.join('\n'));

  // Проверки: факты gates.<n>.json, а не статичный список команд.
  const checkLines = ['## Проверки', ''];
  if (gateEntries.length === 0) {
    checkLines.push('Гейты не запускались.');
  } else {
    for (const gate of gateEntries) {
      const checked = gate.status === 'pass' || gate.status === 'skipped';
      checkLines.push(
        `- [${checked ? 'x' : ' '}] \`${gate.id}\` — ${gate.status}${gateNote(gate)}`,
      );
    }
  }
  sections.push(checkLines.join('\n'));

  // Независимая оценка (§5.7).
  const positiveReview = review.verdict === REVIEW_POSITIVE;
  const positiveEvaluation = EVALUATION_POSITIVE.includes(evaluation.verdict);
  const evaluationLines = [
    '## Независимая оценка',
    '',
    '### Вердикты',
    '',
    '| Источник | Вердикт |',
    '| --- | --- |',
    `| Ревью | \`${review.verdict}\` |`,
    `| Оценка | \`${evaluation.verdict}\` |`,
    '',
  ];
  if (positiveReview !== positiveEvaluation) {
    evaluationLines.push(
      `Расхождение: ревью — \`${review.verdict}\`, оценка — \`${evaluation.verdict}\`.`,
      '',
    );
  }
  evaluationLines.push(`Итераций: ${state.iteration} из ${state.max_iterations}.`, '');

  const evaluationCriteria = Array.isArray(evaluation.criteria) ? evaluation.criteria : [];
  /** @type {Map<string, Record<string, any>>} первое вхождение id: порядок задаёт criteria.md */
  const criteriaById = new Map();
  for (const criterion of evaluationCriteria) {
    if (!criteriaById.has(criterion.id)) criteriaById.set(criterion.id, criterion);
  }

  // Полнота оценивания: критерий из `criteria.md` без статуса — ошибка сборки тела PR
  // (код 2), а не строка со `—`: PR обязан показывать статус каждого критерия.
  const unrated = criteria.filter((criterion) => !criteriaById.has(criterion.id));
  if (unrated.length > 0) {
    throw new Error(
      `evaluation.criteria: нет статуса для критериев из ${CRITERIA_FILE}: ${unrated
        .map((criterion) => criterion.id)
        .join(', ')}`,
    );
  }

  evaluationLines.push(
    '### Критерии',
    '',
    '| Критерий | Статус | Свидетельство |',
    '| --- | --- | --- |',
  );
  /** @type {string[]} */
  const partial = [];
  /** @type {string[]} */
  const unverifiedCriteria = [];
  for (const criterion of criteria) {
    const rated = /** @type {Record<string, any>} */ (criteriaById.get(criterion.id));
    const { status } = rated;
    if (status === 'partial') partial.push(criterion.id);
    if (status === 'unverified') unverifiedCriteria.push(criterion.id);
    evaluationLines.push(
      `| ${criterion.id}: ${cell(criterion.text)} | ${status} | ${evidenceCell(rated, ctx)} |`,
    );
  }
  if (partial.length > 0) {
    evaluationLines.push('', `Частично (\`partial\`): ${partial.join(', ')}.`);
  }
  if (unverifiedCriteria.length > 0) {
    evaluationLines.push('', `Не проверено (\`unverified\`): ${unverifiedCriteria.join(', ')}.`);
  }

  const findings = Array.isArray(review.findings) ? review.findings : [];
  if (findings.length > 0) {
    evaluationLines.push('', '### Замечания ревью', '');
    for (const finding of findings) {
      // `id` находки — тоже непустая строка из артефакта без шаблона в схеме: маскируется.
      evaluationLines.push(
        `- \`${redacted(finding.id)}\` [${finding.severity}] ${redacted(finding.summary)}`,
      );
    }
  }

  if (decision.action === PROCEED_WITH_UNVERIFIED) {
    evaluationLines.push('', '### Не проверено (снять может владелец)', '');

    const decisionItems = Array.isArray(decision.unverified) ? decision.unverified : [];
    const evaluationUnverified = Array.isArray(evaluation.unverified) ? evaluation.unverified : [];

    // Один факт приходит из двух артефактов (`evaluation unverified: …` и `what — why`):
    // дедупликация до маскирования-независимой разметки, чтобы чекбоксов не было вдвое.
    const unchecked = dedupeUnverified([
      ...decisionItems.map((item) => redacted(item)),
      ...evaluationUnverified.map((item) => `${redacted(item.what)} — ${redacted(item.why)}`),
    ]).map((item) => `- [ ] ${item}`);

    if (unchecked.length === 0) evaluationLines.push('Отметок нет.');
    else evaluationLines.push(...unchecked);
  }
  sections.push(evaluationLines.join('\n'));

  // Риски: пункты шаблона, их отмечает человек.
  sections.push(['## Риски', '', ...RISK_ITEMS.map((item) => `- [ ] ${item}`)].join('\n'));

  // Вне скоупа: пункты followups.md; файла нет — заглушка, а не ошибка.
  const followupLines = ['## Вне скоупа', ''];
  if (followups.length === 0) followupLines.push('Нет пунктов вне скоупа.');
  else followupLines.push(...followups.map((item) => `- ${redacted(item)}`));
  sections.push(followupLines.join('\n'));

  return `${sections.join('\n\n')}\n`;
}

/**
 * Разбирает аргументы командной строки. Любой мусор — ошибка использования (код 2).
 * @param {string[]} argv
 * @returns {{ dir: string|null, draftEscalation: boolean }}
 */
export function parseArgs(argv) {
  /** @type {string|null} */
  let dir = null;
  let draftEscalation = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dir') {
      const value = argv[index + 1];
      if (!isText(value) || value.startsWith('--')) {
        throw new Error('--dir: ожидается путь к каталогу цикла');
      }
      dir = value;
      index += 1;
      continue;
    }
    if (arg === '--draft-escalation') {
      draftEscalation = true;
      continue;
    }
    throw new Error(`неизвестный аргумент: ${arg}`);
  }

  return { dir, draftEscalation };
}

/**
 * Читает обязательный JSON-артефакт и проверяет схему. Отсутствие или порча — отказ
 * (код 2): без артефакта соответствующий раздел PR был бы выдуманным.
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
 * Читает необязательный JSON-артефакт: отсутствие файла — `null`, порча — отказ
 * (повреждённый артефакт нельзя молча показать пустым разделом).
 * @param {string} file
 * @param {(doc: unknown) => { ok: boolean, errors: string[] }} validator
 * @param {string} label
 * @returns {Record<string, any>|null}
 */
function readOptionalJson(file, validator, label) {
  if (!existsSync(file)) return null;
  return readRequiredJson(file, validator, label);
}

/**
 * Обязательный текстовый артефакт (`evidence/criteria.md`).
 * @param {string} file
 * @param {string} label
 * @returns {string}
 */
function readRequiredText(file, label) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: не читается (${file}): ${reason}`, { cause: error });
  }
}

/**
 * Точка входа CLI. На диск ничего не пишет: единственный вывод — тело PR в stdout,
 * диагностика — в stderr.
 * @returns {void}
 */
function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const root = repoRoot();
    const dir = args.dir === null ? findActiveCycle() : resolve(args.dir);

    const state = readRequiredJson(join(dir, FIXED_NAMES.state), validateState, FIXED_NAMES.state);
    const names = iterNames(state.iteration);

    const gates = readRequiredJson(join(dir, names.gates), validateGates, names.gates);
    const review = readRequiredJson(join(dir, names.reviewJson), validateReview, names.reviewJson);
    const evaluation = readRequiredJson(
      join(dir, names.evaluationJson),
      validateEvaluation,
      names.evaluationJson,
    );
    const decision = readRequiredJson(join(dir, names.decision), validateDecision, names.decision);

    const criteria = parseCriteria(
      readRequiredText(join(dir, FIXED_NAMES.evidenceDir, CRITERIA_FILE), CRITERIA_FILE),
    );
    if (criteria.length === 0) {
      throw new Error(`${CRITERIA_FILE}: нет строк вида «- C1: формулировка»`);
    }

    const escalation = args.draftEscalation
      ? readOptionalJson(
          join(dir, FIXED_NAMES.escalation),
          validateEscalation,
          FIXED_NAMES.escalation,
        )
      : null;
    const followupsPath = join(dir, FIXED_NAMES.followups);
    const followups = existsSync(followupsPath)
      ? listItems(readFileSync(followupsPath, 'utf8'))
      : [];

    const body = renderPrBody({
      state,
      gates,
      review,
      evaluation,
      decision,
      criteria,
      summary: summaryItems(dir, names),
      followups,
      escalation,
      root,
    });
    process.stdout.write(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`cycle-pr-body: ${message}\n`);
    process.exitCode = 2;
  }
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
