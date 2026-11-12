#!/usr/bin/env node
/**
 * Проверка границ архитектуры (ED small + монорепо).
 *
 * Правила:
 *  1. Внутри приложения разрешены только переходы app → features → services → shared
 *     (app=0, features=1, services=2, shared=3; импорт "вверх" запрещён).
 *  2. Относительные импорты не выходят за пределы `src` приложения.
 *  3. Фича не импортирует внутренности другой фичи — только её `index.ts`.
 *  4. Приложения не импортируют друг друга.
 *  5. `packages/contracts` — только `zod` и относительные импорты, и только публичный API снаружи.
 *  6. Приложения не тянут собранный `dist` и исходники пакетов в обход публичного API.
 *
 * Запуск: `pnpm check:arch`. Нарушение — BLOCKER, exit code 1.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const APPS = ['apps/api', 'apps/web'];
const LAYERS = /** @type {const} */ ({ app: 0, features: 1, services: 2, shared: 3 });
const CONTRACTS_DIR = 'packages/contracts/src';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js']);

const IMPORT_RE = /(?:^|[\s;])import\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
const EXPORT_RE = /(?:^|[\s;])export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

/** @type {string[]} */
const violations = [];

/**
 * @param {string} file путь относительно корня репо
 * @param {string} rule
 * @param {string} message
 */
function report(file, rule, message) {
  violations.push(`${file}: [${rule}] ${message}`);
}

/** @param {string} dir */
async function collectFiles(dir) {
  /** @type {string[]} */
  const result = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectFiles(full)));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      result.push(full);
    }
  }
  return result;
}

/** @param {string} text */
function extractImports(text) {
  const found = new Set();
  for (const re of [IMPORT_RE, EXPORT_RE, DYNAMIC_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found];
}

/** @param {string} absPath */
function toRel(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

/**
 * Слой приложения по абсолютному пути к файлу.
 * @param {string} absPath
 * @returns {keyof typeof LAYERS | null}
 */
function layerOf(absPath) {
  const parts = absPath.split(path.sep);
  const srcIndex = parts.lastIndexOf('src');
  if (srcIndex === -1) return null;
  const candidate = parts[srcIndex + 1];
  return candidate && Object.hasOwn(LAYERS, candidate) ? /** @type {any} */ (candidate) : null;
}

/**
 * @param {string} absPath
 * @returns {{ app: string | null, layer: string | null, feature: string | null }}
 */
function locate(absPath) {
  const parts = absPath.split(path.sep);
  const appsIndex = parts.lastIndexOf('apps');
  const app = appsIndex === -1 ? null : (parts[appsIndex + 1] ?? null);
  const layer = layerOf(absPath);
  let feature = null;
  const srcIndex = parts.lastIndexOf('src');
  if (srcIndex !== -1 && parts[srcIndex + 1] === 'features') {
    feature = parts[srcIndex + 2] ?? null;
  }
  return { app, layer, feature };
}

/** @param {string} filePath */
async function checkContractsFile(filePath) {
  const rel = toRel(filePath);
  const text = await readFile(filePath, 'utf8');

  for (const specifier of extractImports(text)) {
    if (specifier.startsWith('.')) continue;
    if (specifier === 'zod' || specifier.startsWith('zod/')) continue;
    report(
      rel,
      'contracts:env',
      `запрещённая зависимость "${specifier}" (разрешены только zod и относительные импорты)`,
    );
  }
}

/** @param {string} filePath */
async function checkAppFile(filePath) {
  const rel = toRel(filePath);
  const text = await readFile(filePath, 'utf8');
  const from = locate(filePath);
  const fromDir = path.dirname(filePath);

  for (const specifier of extractImports(text)) {
    if (specifier.startsWith('@hair-lab/contracts/')) {
      report(
        rel,
        'contracts:deep-import',
        `глубокий импорт контрактов "${specifier}" — используйте "@hair-lab/contracts"`,
      );
      continue;
    }

    if (specifier === '@hair-lab/api' || specifier === '@hair-lab/web') {
      const target = specifier.split('/')[1];
      if (target !== from.app) {
        report(rel, 'monorepo:cross-app', `приложение не должно импортировать "${specifier}"`);
      }
      continue;
    }

    if (/^@hair-lab\/[^/]+\/(src|dist)(\/|$)/.test(specifier)) {
      report(rel, 'monorepo:internal-path', `импорт внутреннего пути пакета "${specifier}"`);
      continue;
    }

    if (!specifier.startsWith('.')) continue;

    const resolved = path.resolve(fromDir, specifier);
    const target = locate(resolved);

    if (
      path
        .relative(path.join(ROOT, from.app ? `apps/${from.app}/src` : ROOT), resolved)
        .startsWith('..')
    ) {
      report(rel, 'layers:escape', `импорт "${specifier}" выходит за пределы src приложения`);
      continue;
    }

    if (from.layer && target.layer) {
      const order = LAYERS[from.layer];
      const targetOrder = LAYERS[target.layer];
      if (targetOrder < order) {
        report(
          rel,
          'layers:upward',
          `импорт "вверх" по слоям: ${from.layer} → ${target.layer} ("${specifier}"); разрешено только к слоям ниже`,
        );
        continue;
      }
    }

    if (from.feature && target.feature && from.feature !== target.feature) {
      const isPublic = path.basename(resolved).replace(/\.(ts|tsx|mts|mjs|js)$/, '') === 'index';
      if (!isPublic) {
        report(
          rel,
          'features:private-import',
          `импорт внутренностей фичи "${target.feature}" ("${specifier}") — только через её index.ts`,
        );
      }
    }
  }
}

async function main() {
  const contractFiles = await collectFiles(path.join(ROOT, CONTRACTS_DIR));
  for (const file of contractFiles) {
    if (/\.test\.ts$/.test(file)) continue;
    await checkContractsFile(file);
  }

  for (const app of APPS) {
    const appFiles = await collectFiles(path.join(ROOT, app, 'src'));
    for (const file of appFiles) {
      await checkAppFile(file);
    }
  }

  if (violations.length > 0) {
    console.error('Нарушения границ архитектуры:\n');
    for (const violation of violations) console.error(`  BLOCKER ${violation}`);
    console.error(
      `\nВсего нарушений: ${violations.length}. См. AGENTS.md, раздел «Архитектура (ED small)».`,
    );
    process.exit(1);
  }

  console.log('Границы архитектуры в порядке.');
}

await main();
