/**
 * Данные ядра цикла: определения гейтов (§5.5), лимиты (§5.2) и стартовые тайм-ауты.
 *
 * Логики запуска здесь нет — её реализует `cycle-gates.mjs` (T3). Модуль остаётся
 * данными, чтобы порядок и условия гейтов можно было проверять тестами без запуска процессов.
 * Shebang не нужен: модуль подключается из CLI-скриптов `cycle-*.mjs`.
 */

/**
 * @typedef {object} GateDefinition
 * @property {string} id идентификатор гейта, он же имя лога `gates/<id>.<n>.log`
 * @property {string|null} cmd команда (`null` — встроенная проверка внутри скрипта).
 *   Аргументы разделяются пробелом и запускаются без оболочки.
 * @property {boolean} required обязательный гейт: `fail`/`not_run` важен для решения
 * @property {string[]} dependsOn id гейтов-родителей: их `fail`/`not_run` даёт зависимому
 *   `not_run` с причиной `blocked_by:<id>`
 * @property {string[]} pathPrefixes префиксы путей диффа, при которых гейт запускается;
 *   пустой массив — «всегда»
 */

/**
 * Гейты в нормативном порядке выполнения (§5.5). Массив и объекты заморожены:
 * случайная правка порядка или состава в рантайме сломала бы отчёт для PR.
 * @type {readonly GateDefinition[]}
 */
export const GATES = Object.freeze([
  Object.freeze({
    id: 'contracts_build',
    cmd: 'pnpm --filter @hair-lab/contracts build',
    required: true,
    dependsOn: [],
    pathPrefixes: [],
  }),
  Object.freeze({
    id: 'typecheck',
    cmd: 'pnpm typecheck',
    required: true,
    dependsOn: ['contracts_build'],
    pathPrefixes: [],
  }),
  Object.freeze({
    id: 'lint',
    cmd: 'pnpm lint',
    required: true,
    dependsOn: [],
    pathPrefixes: [],
  }),
  Object.freeze({
    id: 'check_arch',
    cmd: 'pnpm check:arch',
    required: true,
    dependsOn: [],
    pathPrefixes: [],
  }),
  Object.freeze({
    id: 'lint_workflows',
    cmd: 'pnpm lint:workflows',
    required: true,
    dependsOn: [],
    pathPrefixes: ['.github/workflows/'],
  }),
  Object.freeze({
    id: 'test',
    cmd: 'pnpm test',
    required: true,
    dependsOn: ['contracts_build'],
    pathPrefixes: [],
  }),
  Object.freeze({
    id: 'test_int',
    cmd: 'pnpm test:int',
    required: true,
    dependsOn: ['contracts_build'],
    pathPrefixes: ['apps/api/', 'packages/contracts/'],
  }),
  Object.freeze({
    id: 'test_scripts',
    cmd: 'pnpm test:scripts',
    required: true,
    dependsOn: [],
    pathPrefixes: ['scripts/'],
  }),
  Object.freeze({
    id: 'check_harness',
    cmd: 'pnpm check:harness',
    required: true,
    dependsOn: [],
    pathPrefixes: ['.pi/', 'scripts/cycle-', 'AGENTS.md'],
  }),
  Object.freeze({
    id: 'format_check',
    cmd: 'pnpm format:check',
    required: true,
    dependsOn: [],
    pathPrefixes: [],
  }),
  Object.freeze({
    id: 'secrets_scan',
    // Встроенная проверка `scanSecrets` по добавленным строкам диффа (T1b/T3).
    cmd: null,
    required: true,
    dependsOn: [],
    pathPrefixes: [],
  }),
]);

/**
 * Лимиты §5.2. `maxDiffLines`/`maxDiffBytes` — порог `diff_too_large` (код 4);
 * `logMaxBytes` — при превышении в логе гейта сохраняется хвост;
 * `evidenceTailLines` — хвост логов в пакете для оценщика;
 * `defaultMaxIterations` — `--max-iterations` по умолчанию.
 */
export const LIMITS = Object.freeze({
  maxDiffLines: 2000,
  maxDiffBytes: 400 * 1024,
  logMaxBytes: 5 * 1024 * 1024,
  evidenceTailLines: 200,
  defaultMaxIterations: 2,
});

/**
 * Стартовые тайм-ауты гейтов, мс. Значения НЕ нормативны: это заготовка для T3,
 * они уточняются по фактическим прогонам. Ключи совпадают с `id` в `GATES`.
 */
export const GATE_TIMEOUTS = Object.freeze({
  contracts_build: 120_000,
  typecheck: 300_000,
  lint: 300_000,
  check_arch: 60_000,
  lint_workflows: 60_000,
  test: 300_000,
  test_int: 900_000,
  test_scripts: 120_000,
  check_harness: 60_000,
  format_check: 120_000,
  secrets_scan: 60_000,
});
