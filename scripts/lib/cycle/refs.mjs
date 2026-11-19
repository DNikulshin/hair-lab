/**
 * Ссылки на свидетельства цикла (docs/orchestrator-core.md §5.2).
 *
 * Формы: `path:line` (файл репозитория и номер строки), `path:start-end` (диапазон строк
 * того же файла, обе границы включительно), `gate:<id>` (гейт из `gates.<n>.json`),
 * `qa:<id>` (шаг из `qa-web.json`). Ссылки приходят из вывода
 * агентов, поэтому разрешение защитное: абсолютные пути, `..`, `.pi/artifacts/`,
 * `node_modules/` и `.env*` (кроме `.env.example`) запрещены, файл должен
 * существовать, строка (обе границы диапазона) — попадать в файл. Диапазон разрешается
 * по началу: счётчики §5.6 и понижение невалидных блокеров считают его одной ссылкой,
 * иначе правка одной формы записи меняла бы вердикты. Запрет `.env*` живёт здесь, а не в
 * потребителях: `resolveRef` открывает файл, чтобы проверить номер строки, значит
 * проверка обязана быть до чтения и в одном месте для всех вызывающих (AGENTS.md,
 * «Персональные данные и безопасность»).
 * Проверки пути идут по каноническому пути (`realpathSync`): символическая ссылка
 * не должна выводить за корень репозитория или в запрещённую область.
 * Shebang не нужен: модуль подключается из CLI-скриптов `cycle-*.mjs`.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** `gate:<id>`: те же символы, что id гейтов в `config.mjs`. */
const GATE_REF = /^gate:([A-Za-z0-9_-]+)$/;
/** `qa:<id>`: id шагов QA — `s1`, `s2`, … (D8). */
const QA_REF = /^qa:([A-Za-z0-9_-]+)$/;
/**
 * `path:line` и `path:start-end`: путь без двоеточия в конце, номер строки — цифры,
 * необязательный диапазон — `start-end` (обе границы включительно).
 */
const PATH_REF = /^(.+):(\d+)(?:-(\d+))?$/;

/** Привод Windows-пути: `C:\repo` абсолютен, хотя posix `isAbsolute` этого не видит. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:/;

/** Единственный разрешённый к чтению файл окружения (AGENTS.md, «Персональные данные»). */
const ENV_EXAMPLE = '.env.example';

/**
 * Сегмент запрещённого файла окружения: `.env`, `.env.local`, `.env.production`.
 * Регистр не важен: агент может ошибиться в написании, а на регистронезависимых ФС
 * `.ENV` — тот же файл.
 * @param {string} segment
 * @returns {boolean}
 */
function isEnvSegment(segment) {
  const lower = segment.trim().toLowerCase();
  return lower.startsWith('.env') && lower !== ENV_EXAMPLE;
}

/**
 * @typedef {object} ParsedRef
 * @property {'path'|'gate'|'qa'} kind вид ссылки
 * @property {string} value путь (для `path`) или идентификатор (`gate`, `qa`)
 * @property {number|null} line номер строки (у диапазона — начало); у `gate:`/`qa:` — `null`
 * @property {number|null} endLine конец диапазона; `null` для одиночной строки и `gate:`/`qa:`
 */

/**
 * @typedef {object} RefContext
 * @property {string} root корень репозитория: от него считается путь ссылки
 * @property {unknown} [gates] разобранный `gates.<n>.json` или `null`, если файла нет
 * @property {unknown} [qa] разобранный `qa-web.json` или `null`, если файла нет
 */

/**
 * @typedef {object} RefResolution
 * @property {boolean} ok ссылка разрешилась
 * @property {string} ref исходная строка
 * @property {'path'|'gate'|'qa'|null} kind вид ссылки (`null`, если форма не распознана)
 * @property {string|null} value нормализованный путь или идентификатор
 * @property {number|null} line номер строки (у диапазона — начало)
 * @property {number|null} endLine конец диапазона (`null`, если ссылка не диапазон)
 * @property {string|null} file абсолютный путь к файлу (только для `path`)
 * @property {string|null} error причина отказа (только при `ok: false`)
 */

/**
 * Разбирает строку ссылки. Ошибка — нераспознанная форма: это не «неразрешённая»
 * ссылка, а некорректный ввод, и вызывающий обычно хочет об этом знать.
 * @param {unknown} ref
 * @returns {ParsedRef}
 */
export function parseRef(ref) {
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new Error(`ссылка: ожидается непустая строка, получено ${JSON.stringify(ref)}`);
  }
  // Пробелы вокруг ссылки — обычная погрешность markdown, значения не меняют.
  const value = ref.trim();

  const gate = GATE_REF.exec(value);
  if (gate) return { kind: 'gate', value: gate[1], line: null, endLine: null };

  const qa = QA_REF.exec(value);
  if (qa) return { kind: 'qa', value: qa[1], line: null, endLine: null };

  const path = PATH_REF.exec(value);
  if (path) {
    return {
      kind: 'path',
      value: path[1],
      line: Number(path[2]),
      endLine: path[3] === undefined ? null : Number(path[3]),
    };
  }

  throw new Error(
    `ссылка: не распознана форма (ожидается path:line, path:start-end, gate:<id>, qa:<id>): ${value}`,
  );
}

/**
 * Число строк файла. `split('\n')` на файле с завершающим переводом даёт лишний пустой
 * элемент, поэтому он вычитается; файл без `\n` в конце сохраняет своё число строк и не
 * позволяет сослаться на «строку N+1».
 * @param {string} text
 * @returns {number}
 */
function countLines(text) {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/**
 * Проверяет путь ссылки и возвращает его нормализованные сегменты.
 * @param {string} value
 * @returns {{ segments: string[] } | { problem: string }}
 */
function safeSegments(value) {
  if (value.trim() === '') return { problem: 'пустой путь' };
  if (value.includes('\\')) return { problem: `обратные слэши в пути запрещены: ${value}` };
  if (isAbsolute(value) || WINDOWS_ABSOLUTE.test(value)) {
    return { problem: `абсолютный путь запрещён: ${value}` };
  }

  // Пустые сегменты (`a//b`) и текущий каталог (`./a`) на безопасность не влияют.
  const segments = value.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) return { problem: `пустой путь: ${value}` };
  if (segments.includes('..')) return { problem: `«..» в пути запрещён: ${value}` };

  const dotPi = segments.indexOf('.pi');
  if (dotPi !== -1 && segments[dotPi + 1] === 'artifacts') {
    return { problem: `путь в .pi/artifacts/ запрещён: ${value}` };
  }
  if (segments.includes('node_modules')) {
    return { problem: `путь в node_modules/ запрещён: ${value}` };
  }
  // `.env*` открывается только как `.env.example`: `resolveRef` читает файл ради номера
  // строки, а это нарушило бы AGENTS.md («.env*, кроме .env.example, не читать»).
  const env = segments.find(isEnvSegment);
  if (env !== undefined) {
    return { problem: `чтение ${env} запрещено (разрешён только ${ENV_EXAMPLE}): ${value}` };
  }

  return { segments };
}

/**
 * Начальное значение результата: заполняется по мере проверки.
 * @param {unknown} ref
 * @returns {RefResolution}
 */
function emptyResolution(ref) {
  return {
    ok: false,
    ref: typeof ref === 'string' ? ref : String(ref),
    kind: null,
    value: null,
    line: null,
    endLine: null,
    file: null,
    error: null,
  };
}

/**
 * Отказ с причиной.
 * @param {RefResolution} base
 * @param {ParsedRef|null} parsed
 * @param {string} error
 * @returns {RefResolution}
 */
function fail(base, parsed, error) {
  return {
    ...base,
    ok: false,
    kind: parsed ? parsed.kind : null,
    value: parsed ? parsed.value : null,
    line: parsed ? parsed.line : null,
    endLine: parsed ? parsed.endLine : null,
    error,
  };
}

/**
 * Разрешает ссылку в контексте цикла. Отсутствие `gates`/`qa` в контексте (`null`)
 * означает, что такие ссылки разрешить нельзя: молча считать их верными нельзя,
 * на этом строится счётчик `unresolved_refs` (§5.6).
 * @param {unknown} ref строка `path:line`, `path:start-end`, `gate:<id>` или `qa:<id>`
 * @param {RefContext} ctx
 * @returns {RefResolution}
 */
export function resolveRef(ref, ctx) {
  const base = emptyResolution(ref);

  /** @type {ParsedRef} */
  let parsed;
  try {
    parsed = parseRef(ref);
  } catch (error) {
    return fail(base, null, error instanceof Error ? error.message : String(error));
  }

  if (parsed.kind === 'path') return resolvePath(base, parsed, ctx);
  if (parsed.kind === 'gate') return resolveGate(base, parsed, ctx);
  return resolveQa(base, parsed, ctx);
}

/**
 * Лежит ли канонический путь внутри канонического каталога.
 * @param {string} parent канонический каталог
 * @param {string} child канонический путь
 * @returns {boolean}
 */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * `path:line` / `path:start-end`: путь внутри репозитория и существующая строка (обе
 * границы диапазона в пределах файла, начало не больше конца).
 * @param {RefResolution} base
 * @param {ParsedRef} parsed
 * @param {RefContext} ctx
 * @returns {RefResolution}
 */
function resolvePath(base, parsed, ctx) {
  const safe = safeSegments(parsed.value);
  if ('problem' in safe) return fail(base, parsed, safe.problem);

  const root = ctx && typeof ctx.root === 'string' ? ctx.root : '';
  if (root === '') return fail(base, parsed, 'не задан корень репозитория (ctx.root)');

  const relativePath = safe.segments.join('/');
  // `file` остаётся логическим путём в репозитории: по нему читают отчёты,
  // а проверки ниже идут по каноническим путям.
  const file = join(root, ...safe.segments);

  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    return fail(base, parsed, `корень репозитория не найден: ${root}`);
  }

  // `statSync` идёт по символической ссылке, поэтому сначала разрешается канонический
  // путь: иначе ссылка на файл вне репозитория прошла бы как свидетельство.
  let canonicalFile;
  try {
    canonicalFile = realpathSync(file);
  } catch {
    return fail(base, parsed, `файл не найден: ${relativePath}`);
  }

  if (!isInside(canonicalRoot, canonicalFile)) {
    return fail(base, parsed, `путь выходит за пределы репозитория: ${relativePath}`);
  }

  try {
    if (!statSync(canonicalFile).isFile()) return fail(base, parsed, `не файл: ${relativePath}`);
  } catch {
    return fail(base, parsed, `файл не найден: ${relativePath}`);
  }

  // Запрещённые области проверяются и по каноническому пути: символическая ссылка
  // не должна обходить запрет на `.pi/artifacts/` и `node_modules/`.
  const canonical = safeSegments(relative(canonicalRoot, canonicalFile).split(sep).join('/'));
  if ('problem' in canonical) {
    return fail(base, parsed, `символическая ссылка ведёт в запрещённый путь: ${relativePath}`);
  }

  let text;
  try {
    text = readFileSync(canonicalFile, 'utf8');
  } catch {
    return fail(base, parsed, `файл не найден: ${relativePath}`);
  }

  const line = parsed.line ?? 0;
  if (line < 1) return fail(base, parsed, `номер строки должен быть ≥ 1, получено ${line}`);

  const lines = countLines(text);
  if (line > lines) {
    return fail(base, parsed, `строка ${line} за концом файла ${relativePath} (строк: ${lines})`);
  }

  const endLine = parsed.endLine ?? null;
  if (endLine !== null) {
    if (endLine < line) {
      return fail(
        base,
        parsed,
        `диапазон ${line}-${endLine}: конец меньше начала (${relativePath})`,
      );
    }
    if (endLine > lines) {
      return fail(
        base,
        parsed,
        `строка ${endLine} за концом файла ${relativePath} (строк: ${lines})`,
      );
    }
  }

  return { ...base, ok: true, kind: 'path', value: relativePath, line, endLine, file };
}

/**
 * `gate:<id>`: гейт есть в переданном `gates.<n>.json`.
 * @param {RefResolution} base
 * @param {ParsedRef} parsed
 * @param {RefContext} ctx
 * @returns {RefResolution}
 */
function resolveGate(base, parsed, ctx) {
  const gates = ctx ? ctx.gates : null;
  if (gates === null || gates === undefined) {
    return fail(base, parsed, `gates.<n>.json не передан: ссылка gate:${parsed.value} неразрешима`);
  }

  const entries =
    typeof gates === 'object' && gates !== null && Array.isArray(gates.gates) ? gates.gates : null;
  if (entries === null) {
    return fail(base, parsed, 'в gates.<n>.json нет массива gates');
  }

  const found = entries.some(
    (gate) => typeof gate === 'object' && gate !== null && gate.id === parsed.value,
  );
  if (!found) return fail(base, parsed, `гейт не найден в gates.<n>.json: ${parsed.value}`);

  return { ...base, ok: true, kind: 'gate', value: parsed.value, line: null };
}

/**
 * `qa:<id>`: шаг есть в переданном `qa-web.json`.
 * @param {RefResolution} base
 * @param {ParsedRef} parsed
 * @param {RefContext} ctx
 * @returns {RefResolution}
 */
function resolveQa(base, parsed, ctx) {
  const qa = ctx ? ctx.qa : null;
  if (qa === null || qa === undefined) {
    return fail(base, parsed, `qa-web.json не передан: ссылка qa:${parsed.value} неразрешима`);
  }

  const steps = typeof qa === 'object' && qa !== null && Array.isArray(qa.steps) ? qa.steps : null;
  if (steps === null) return fail(base, parsed, 'в qa-web.json нет массива steps');

  const found = steps.some(
    (step) => typeof step === 'object' && step !== null && step.id === parsed.value,
  );
  if (!found) return fail(base, parsed, `шаг не найден в qa-web.json: ${parsed.value}`);

  return { ...base, ok: true, kind: 'qa', value: parsed.value, line: null };
}
