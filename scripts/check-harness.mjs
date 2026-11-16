#!/usr/bin/env node
/**
 * Проверка раскладки harness по docs/orchestrator-core.md §5.9 (issue #153, задача T2).
 *
 * Вход: `.pi/agents/{plan,code,review,evaluate}.md` (frontmatter), `.pi/settings.json`,
 * `.pi/prompts/cycle.md`, `AGENTS.md`. Выход: строки `H<n>: <файл> — <что не так>`
 * в stdout, диагностика чтения — в stderr. Аргументов нет: проверяется корень репозитория.
 *
 * Диагностика чтения состоит из относительного пути и человекочитаемой причины. Системный
 * текст ошибки (`error.message`) не печатается: Node подставляет в него абсолютный путь
 * (`ENOENT: no such file or directory, open '/abs/path'`), из-за чего вывод зависел бы от
 * расположения дерева. Вместо него используется `error.code` (§5.9).
 * `--root <dir>` подменяет корень — так тесты проверяют фикстурные деревья и не зависят
 * от реальных `.pi/**` и `AGENTS.md` (§5.10: никаких обращений к сети и `pnpm`).
 *
 * Правила H1–H6 (§5.9):
 * - H1 — агенты `plan`, `code`, `review`, `evaluate` есть; поля `name`, `model`,
 *   `thinking`, `tools` заданы; `name` = имени файла без `.md`;
 * - H2 — семейство `code` ≠ `review`, семейство `evaluate` ∉ {`code`, `review`};
 * - H3 — у `plan` нет `bash`, `edit`, `write`; у `review` и `evaluate` нет `edit`, `write`;
 * - H4 — все `model` начинаются с `polza-ai/`;
 * - H5 — `subagents.maxSubagentSpawnsPerRun` ≥ 7;
 * - H6 — `cycle.md` содержит все имена этапов автомата §5.3; `AGENTS.md` не содержит
 *   идентификаторов моделей (`deepseek`, `glm-?\d`, `gpt-?\d`, `claude-(opus|sonnet|haiku|fable)`,
 *   `polza-ai/`, без учёта регистра). Продуктовое название «Claude Code» под шаблон не
 *   попадает и нарушением не считается (§11, возражение 1).
 *
 * H2 и H4 работают только с вычислимым семейством: семейство — второй сегмент `model`
 * (`polza-ai/<семейство>/<модель>`). Если файла агента нет (это уже нарушение H1) или его
 * `model` пуст/не по шаблону (это нарушение H4), H2 молча пропускает это ребро графа:
 * иначе один и тот же дефект печатался бы дважды и под чужим правилом. Решение осознанное:
 * H1 отвечает за «агент есть и поля заданы», H4 — за провайдера, H2 — только за
 * независимость семейств у тех агентов, где семейство действительно известно.
 * Пары H2 проверяются по одной: `code`↔`review`, `evaluate`↔`code`, `evaluate`↔`review`.
 *
 * H6 по `cycle.md` ищет имена этапов без учёта регистра и по границам слов: до T7 промпт
 * называет этапы в нижнем регистре (`plan`, `code`, `review`), и требовать верхний регистр
 * значило бы ловить оформление, а не состав этапов.
 *
 * Вывод детерминирован: правила идут H1→H6, внутри правила файлы — в фиксированном порядке
 * (`plan`, `code`, `review`, `evaluate`, `.pi/settings.json`, `.pi/prompts/cycle.md`,
 * `AGENTS.md`). Несколько замечаний одного правила по одному файлу склеиваются в одну
 * строку через `; `.
 *
 * Коды выхода (§5.9): `0` — всё соответствует; `1` — есть нарушения; `2` — ошибка чтения
 * (нет файла, битый JSON/frontmatter, неизвестный аргумент). Frontmatter без обрамляющих
 * `---` или со строкой не вида `key: value` — ошибка чтения, а не нарушение правил:
 * разобрать такой файл нельзя, и «поля не заданы» были бы догадкой. Отсутствие файла
 * агента — наоборот, нарушение H1: правило прямо требует наличия агентов.
 *
 * Frontmatter парсится локально (§5.9: блок между `---`, строки `key: value`, значения
 * в кавычках допустимы, `tools` — список через запятую). YAML-библиотека не добавляется,
 * `lib/cycle` не расширяется (§5.2: парсер нужен одному скрипту).
 *
 * Shebang нужен: файл запускается напрямую.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень репозитория по умолчанию: родитель каталога `scripts/`. */
const DEFAULT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Агенты проекта в порядке вывода H1 (§5.9). */
export const AGENT_NAMES = Object.freeze(['plan', 'code', 'review', 'evaluate']);

/** Обязательные поля frontmatter агента (H1). */
const AGENT_FIELDS = Object.freeze(['name', 'model', 'thinking', 'tools']);

/** Имена этапов автомата `cycle-state.mjs` (§5.3) — их должен знать `cycle.md` (H6). */
export const STAGES = Object.freeze([
  'INIT',
  'PLAN',
  'CODE',
  'GATES',
  'QA_WEB',
  'REVIEW',
  'EVALUATE',
  'DECIDE',
  'REWORK',
  'ACQUIRE_EVIDENCE',
  'PR',
  'DONE',
  'ESCALATED',
]);

/** Запрещённые инструменты по агентам (H3). */
const FORBIDDEN_TOOLS = Object.freeze({
  plan: Object.freeze(['bash', 'edit', 'write']),
  code: Object.freeze([]),
  review: Object.freeze(['edit', 'write']),
  evaluate: Object.freeze(['edit', 'write']),
});

/** Минимальное число запусков субагентов за цикл (H5). */
const MIN_SUBAGENT_SPAWNS = 7;

/** Провайдер моделей (§5.9, H4). */
const MODEL_PREFIX = 'polza-ai/';

/** Идентификаторы моделей, которых не должно быть в `AGENTS.md` (H6). */
const MODEL_ID_PATTERNS = Object.freeze([
  /deepseek/iu,
  /glm-?\d/iu,
  /gpt-?\d/iu,
  /claude-(opus|sonnet|haiku|fable)/iu,
  /polza-ai\//iu,
]);

/** Порядок правил в выводе. */
const RULE_ORDER = Object.freeze(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/** Порядок файлов в выводе внутри правила. */
const FILE_ORDER = Object.freeze([
  '.pi/agents/plan.md',
  '.pi/agents/code.md',
  '.pi/agents/review.md',
  '.pi/agents/evaluate.md',
  '.pi/settings.json',
  '.pi/prompts/cycle.md',
  'AGENTS.md',
]);

/**
 * @typedef {{ name: string, file: string, fields: Record<string, string | string[]> | null }} AgentDoc
 *   `fields === null` — файла агента нет (нарушение H1).
 * @typedef {{ agents: AgentDoc[], settings: unknown, cycleText: string, agentsMdText: string }} HarnessInput
 * @typedef {{ rule: string, file: string, messages: string[] }} Violation
 *   Одно нарушение = одна строка вывода: правило + файл + склеенные сообщения.
 */

/**
 * Разбирает frontmatter агента: блок между строками `---`, строки `key: value`,
 * значения в одинарных или двойных кавычках, `tools` — список через запятую.
 * @param {string} text содержимое файла целиком
 * @returns {{ ok: true, fields: Record<string, string | string[]> } | { ok: false, error: string }}
 */
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { ok: false, error: 'нет открывающей строки ---' };
  }

  let end = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index;
      break;
    }
  }
  if (end === -1) {
    return { ok: false, error: 'нет закрывающей строки ---' };
  }

  /** @type {Record<string, string | string[]>} */
  const fields = {};
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (match === null) {
      return { ok: false, error: `строка ${index + 1} не вида "key: value"` };
    }
    const [, key, raw] = match;
    fields[key] = key === 'tools' ? splitList(raw) : unquote(raw.trim());
  }

  return { ok: true, fields };
}

/**
 * Снимает обрамляющие кавычки, если они парные.
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Разбирает список через запятую (`tools: read, grep`).
 * @param {string} raw
 * @returns {string[]}
 */
function splitList(raw) {
  return unquote(raw.trim())
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * Задано ли значение поля: непустая строка или непустой список.
 * @param {string | string[] | undefined} value
 * @returns {boolean}
 */
function hasValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Читает входы проверки из `root`. Ошибки чтения (нет файла, битый JSON/frontmatter)
 * бросаются исключением: молча подставлять пустое значение нельзя — это скрыло бы
 * сломанный harness за «нарушением правил».
 * @param {string} root корень дерева (репозиторий или фикстура)
 * @returns {HarnessInput}
 */
export function readHarness(root) {
  const agents = AGENT_NAMES.map((name) => {
    const file = join(root, '.pi', 'agents', `${name}.md`);
    const label = `.pi/agents/${name}.md`;
    if (!existsSync(file)) {
      return { name, file: label, fields: null };
    }
    const parsed = parseFrontmatter(readText(file, label));
    if (!parsed.ok) {
      throw new Error(`${label} — битый frontmatter: ${parsed.error}`);
    }
    return { name, file: label, fields: parsed.fields };
  });

  return {
    agents,
    settings: readJson(join(root, '.pi', 'settings.json'), '.pi/settings.json'),
    cycleText: readText(join(root, '.pi', 'prompts', 'cycle.md'), '.pi/prompts/cycle.md'),
    agentsMdText: readText(join(root, 'AGENTS.md'), 'AGENTS.md'),
  };
}

/**
 * Причины ошибок чтения без системного текста: `error.message` из Node содержит
 * абсолютный путь к файлу. Неизвестный код печатается как есть, без текста исключения.
 */
const READ_ERROR_REASONS = Object.freeze({
  ENOENT: 'файл не найден',
  EACCES: 'нет доступа на чтение',
  EPERM: 'нет доступа на чтение',
  EISDIR: 'ожидался файл, а не каталог',
});

/**
 * Человекочитаемая причина ошибки чтения по `error.code`.
 * @param {unknown} error
 * @returns {string}
 */
function describeReadError(error) {
  const code = /** @type {{ code?: unknown } | null | undefined} */ (error)?.code;
  if (typeof code !== 'string' || code === '') {
    return 'ошибка чтения';
  }
  return Object.hasOwn(READ_ERROR_REASONS, code) ? READ_ERROR_REASONS[code] : code;
}

/**
 * Причина ошибки разбора JSON без пути и без фрагмента разбираемого текста: сообщение
 * парсера вида `Unexpected token '/', "{ \"a\": /tmp/secre"... is not valid JSON`
 * содержит начало файла, а оно может включать путь.
 * @param {unknown} error
 * @returns {string}
 */
function describeJsonError(error) {
  if (!(error instanceof Error)) {
    return 'ошибка разбора JSON';
  }
  const reason = error.message
    .split(/\r?\n/u)[0]
    .replace(/,\s*".*$/u, '')
    .replace(/ in JSON at position.*$/u, '')
    .trim();
  return reason === '' ? 'ошибка разбора JSON' : reason;
}

/**
 * Читает текстовый файл, превращая ошибку доступа в сообщение с относительным путём.
 * @param {string} file абсолютный путь
 * @param {string} label относительный путь для сообщения
 * @returns {string}
 */
function readText(file, label) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`${label} — ${describeReadError(error)}`, { cause: error });
  }
}

/**
 * Читает JSON-файл; отсутствие и порча — ошибка чтения (код 2).
 * @param {string} file абсолютный путь
 * @param {string} label относительный путь для сообщения
 * @returns {unknown}
 */
function readJson(file, label) {
  const text = readText(file, label);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} — битый JSON: ${describeJsonError(error)}`, { cause: error });
  }
}

/**
 * Семейство модели: второй сегмент `polza-ai/<семейство>/<модель>`.
 * `null` — семейство вычислить нельзя (нет префикса, один сегмент); такие агенты
 * H2 пропускает, их разбирают H1 и H4.
 * @param {string | string[] | undefined} model
 * @returns {string | null}
 */
export function familyOf(model) {
  if (typeof model !== 'string' || !model.startsWith(MODEL_PREFIX)) {
    return null;
  }
  const segments = model.split('/');
  return segments.length >= 3 && segments[1] !== '' ? segments[1] : null;
}

/**
 * Применяет правила H1–H6 к уже прочитанным входам. Чистая функция: файлов не читает,
 * порядок вывода не зависит от порядка ключей объектов.
 * @param {HarnessInput} input
 * @returns {Violation[]}
 */
export function evaluateHarness(input) {
  /** @type {Map<string, Violation>} */
  const buckets = new Map();
  /**
   * @param {string} rule
   * @param {string} file
   * @param {string} message
   * @returns {void}
   */
  const add = (rule, file, message) => {
    const key = `${rule}|${file}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, { rule, file, messages: [message] });
      return;
    }
    bucket.messages.push(message);
  };

  const byName = new Map(input.agents.map((agent) => [agent.name, agent]));
  const family = new Map(input.agents.map((agent) => [agent.name, familyOf(agent.fields?.model)]));

  // H1: агент есть, обязательные поля заданы, `name` = имени файла.
  for (const name of AGENT_NAMES) {
    const agent = byName.get(name);
    if (agent === undefined || agent.fields === null) {
      add('H1', `.pi/agents/${name}.md`, 'агент отсутствует');
      continue;
    }
    const missing = AGENT_FIELDS.filter((field) => !hasValue(agent.fields[field]));
    if (missing.length > 0) {
      add('H1', agent.file, `не заданы поля: ${missing.join(', ')}`);
    }
    const declared = agent.fields.name;
    if (typeof declared === 'string' && declared.trim() !== '' && declared !== name) {
      add('H1', agent.file, `name "${declared}" не совпадает с именем файла "${name}"`);
    }
  }

  // H2: независимость семейств. Ребро проверяется, только если семейства известны у обоих.
  const pairs = [
    ['code', 'review'],
    ['evaluate', 'code'],
    ['evaluate', 'review'],
  ];
  for (const [left, right] of pairs) {
    const leftFamily = family.get(left);
    const rightFamily = family.get(right);
    if (leftFamily === null || leftFamily === undefined) {
      continue;
    }
    if (rightFamily === null || rightFamily === undefined) {
      continue;
    }
    if (leftFamily !== rightFamily) {
      continue;
    }
    const agent = byName.get(left);
    if (agent === undefined) {
      continue;
    }
    add('H2', agent.file, `семейство модели совпадает с ${right}: ${leftFamily}`);
  }

  // H3: у plan нет bash/edit/write; у review и evaluate нет edit/write.
  for (const name of AGENT_NAMES) {
    const agent = byName.get(name);
    if (agent === undefined || agent.fields === null) {
      continue;
    }
    const tools = agent.fields.tools;
    if (!Array.isArray(tools)) {
      continue;
    }
    const forbidden = FORBIDDEN_TOOLS[name].filter((tool) => tools.includes(tool));
    if (forbidden.length > 0) {
      add('H3', agent.file, `запрещённые инструменты: ${forbidden.join(', ')}`);
    }
  }

  // H4: все модели — через polza-ai/.
  for (const name of AGENT_NAMES) {
    const agent = byName.get(name);
    if (agent === undefined || agent.fields === null) {
      continue;
    }
    const model = agent.fields.model;
    if (hasValue(model) && !String(model).startsWith(MODEL_PREFIX)) {
      add('H4', agent.file, `model не начинается с polza-ai/: ${String(model)}`);
    }
  }

  // H5: лимит запусков субагентов за цикл.
  const spawns = readSpawns(input.settings);
  if (spawns.missing) {
    add('H5', '.pi/settings.json', 'subagents.maxSubagentSpawnsPerRun не задан');
  } else if (!Number.isInteger(spawns.value)) {
    add(
      'H5',
      '.pi/settings.json',
      `subagents.maxSubagentSpawnsPerRun должен быть целым: ${JSON.stringify(spawns.value)}`,
    );
  } else if (spawns.value < MIN_SUBAGENT_SPAWNS) {
    add(
      'H5',
      '.pi/settings.json',
      `subagents.maxSubagentSpawnsPerRun = ${spawns.value}, требуется ≥ ${MIN_SUBAGENT_SPAWNS}`,
    );
  }

  // H6 (cycle.md): все имена этапов автомата, регистр не важен.
  const missingStages = STAGES.filter(
    (stage) => !new RegExp(`\\b${stage}\\b`, 'iu').test(input.cycleText),
  );
  if (missingStages.length > 0) {
    add('H6', '.pi/prompts/cycle.md', `нет имён этапов: ${missingStages.join(', ')}`);
  }

  // H6 (AGENTS.md): идентификаторы моделей переезжают в `.pi/agents/*`, не в прозу.
  const identifiers = findModelIdentifiers(input.agentsMdText);
  if (identifiers.length > 0) {
    add('H6', 'AGENTS.md', `идентификаторы моделей: ${identifiers.join(', ')}`);
  }

  return [...buckets.values()].sort(compareViolations);
}

/**
 * Достаёт `subagents.maxSubagentSpawnsPerRun` из настроек.
 * @param {unknown} settings
 * @returns {{ missing: true, value: null } | { missing: false, value: unknown }}
 */
function readSpawns(settings) {
  if (typeof settings !== 'object' || settings === null) {
    return { missing: true, value: null };
  }
  const subagents = /** @type {Record<string, unknown>} */ (settings).subagents;
  if (typeof subagents !== 'object' || subagents === null) {
    return { missing: true, value: null };
  }
  const value = /** @type {Record<string, unknown>} */ (subagents).maxSubagentSpawnsPerRun;
  if (value === undefined) {
    return { missing: true, value: null };
  }
  return { missing: false, value };
}

/**
 * Находит в тексте идентификаторы моделей в порядке первого появления, без повторов
 * (сравнение без учёта регистра). Возвращает найденные написания как есть.
 * @param {string} text
 * @returns {string[]}
 */
export function findModelIdentifiers(text) {
  /** @type {{ index: number, text: string }[]} */
  const found = [];
  for (const pattern of MODEL_ID_PATTERNS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const global = new RegExp(pattern.source, flags);
    for (const match of text.matchAll(global)) {
      found.push({ index: match.index ?? 0, text: match[0] });
    }
  }
  found.sort((left, right) => left.index - right.index);

  /** @type {string[]} */
  const unique = [];
  const seen = new Set();
  for (const item of found) {
    const key = item.text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item.text);
  }
  return unique;
}

/**
 * Сравнение нарушений: сначала правило (H1→H6), затем файл в порядке `FILE_ORDER`.
 * @param {Violation} left
 * @param {Violation} right
 * @returns {number}
 */
function compareViolations(left, right) {
  const ruleDiff = RULE_ORDER.indexOf(left.rule) - RULE_ORDER.indexOf(right.rule);
  if (ruleDiff !== 0) {
    return ruleDiff;
  }
  const leftFile = FILE_ORDER.indexOf(left.file);
  const rightFile = FILE_ORDER.indexOf(right.file);
  const leftIndex = leftFile === -1 ? FILE_ORDER.length : leftFile;
  const rightIndex = rightFile === -1 ? FILE_ORDER.length : rightFile;
  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }
  return left.file.localeCompare(right.file);
}

/**
 * Строка вывода одной строкой: `H<n>: <файл> — <что не так>`.
 * @param {Violation} violation
 * @returns {string}
 */
export function formatViolation(violation) {
  return `${violation.rule}: ${violation.file} — ${violation.messages.join('; ')}`;
}

/**
 * Разбирает аргументы CLI: единственный необязательный — `--root <dir>`.
 * @param {string[]} argv
 * @returns {{ root: string }}
 */
export function parseArgs(argv) {
  /** @type {string | null} */
  let root = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--root: ожидается путь к корню дерева');
      }
      root = value;
      index += 1;
      continue;
    }
    throw new Error(`неизвестный аргумент: ${arg}`);
  }

  return { root: root === null ? DEFAULT_ROOT : resolve(root) };
}

/** Тонкий CLI: печать нарушений в stdout, диагностика — в stderr. */
function main() {
  try {
    const { root } = parseArgs(process.argv.slice(2));
    const violations = evaluateHarness(readHarness(root));
    if (violations.length > 0) {
      process.stdout.write(`${violations.map(formatViolation).join('\n')}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`check-harness: ${message}\n`);
    process.exitCode = 2;
  }
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === fileURLToPath(import.meta.url)) {
  main();
}
