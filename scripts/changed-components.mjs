#!/usr/bin/env node
/* eslint-disable no-console -- CLI-скрипт: вывод в журнал job'а — его единственная задача */
/**
 * Определяет, какие Docker-образы нужно пересобирать для текущего изменения (issue #55).
 *
 * Запускается в job `changes` workflow CI и Release, пишет в `GITHUB_OUTPUT`:
 *   api=true|false, web=true|false, any=true|false, matrix={"include":[{component,dockerfile}]}
 *
 * Принцип — консервативный: собираем образ по умолчанию, пропускаем только пути, которые
 * заведомо не попадают в образ (доки, агентские артефакты, CI-обвязка). Неизвестный путь,
 * ошибка диффа, отсутствие базы (тег, force-push, workflow_dispatch) — собираем всё.
 * Иначе пропущенный путь означал бы тихо задеплоенный старый образ.
 *
 * Локальный запуск: `node scripts/changed-components.mjs` без GITHUB_* — печатает классификацию
 * для всего репозитория (обе сборки), ничего не пишет в выходные файлы.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/** Пути, которые не влияют ни на один образ. */
const IGNORED = [
  /^docs\//,
  /^\.pi\//,
  /^\.github\//,
  /^\.githooks\//,
  /^scripts\//,
  /^[^/]+\.md$/,
  /^LICENSE/,
];

/** Общие зависимости обоих образов: контракты, тулинг, манифесты воркспейса. */
const SHARED = [
  /^packages\/contracts\//,
  /^tooling\//,
  /^pnpm-lock\.yaml$/,
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^tsconfig[^/]*\.json$/,
  /^turbo\.json$/,
  /^\.npmrc$/,
  /^\.dockerignore$/,
];

const API = [/^apps\/api\//];
const WEB = [/^apps\/web\//];

/**
 * Классифицирует список изменённых путей.
 * @param {string[]} files
 * @returns {{ api: boolean, web: boolean }}
 */
export function classify(files) {
  let api = false;
  let web = false;

  for (const file of files) {
    if (IGNORED.some((pattern) => pattern.test(file))) continue;
    if (SHARED.some((pattern) => pattern.test(file))) {
      api = true;
      web = true;
      continue;
    }
    const touchesApi = API.some((pattern) => pattern.test(file));
    const touchesWeb = WEB.some((pattern) => pattern.test(file));
    if (!touchesApi && !touchesWeb) {
      // Незнакомый путь: пересобираем оба образа — лучше лишняя сборка, чем устаревший деплой.
      api = true;
      web = true;
      continue;
    }
    if (touchesApi) api = true;
    if (touchesWeb) web = true;
  }

  return { api, web };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/** Пустая база (тег, первый push, force-push) — нельзя вычислить дифф. */
function isEmptyRevision(sha) {
  return sha === '' || /^0+$/.test(sha);
}

/** @returns {{ base: string, head: string } | null} null — дифф вычислить нельзя */
function resolveRange() {
  const event = process.env.GITHUB_EVENT_NAME ?? '';

  if (event === 'pull_request' || event === 'pull_request_target') {
    const baseRef = process.env.GITHUB_BASE_REF ?? '';
    if (baseRef === '') return null;
    try {
      // fetch-depth: 0 в job'е даёт полную историю, но ref базовой ветки может отсутствовать.
      git([
        'fetch',
        '--no-tags',
        '--quiet',
        'origin',
        `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`,
      ]);
    } catch {
      return null;
    }
    return { base: `origin/${baseRef}`, head: 'HEAD' };
  }

  if (event === 'push') {
    // Тег всегда собирает оба образа: релиз не должен зависеть от диффа.
    if (process.env.GITHUB_REF_TYPE === 'tag') return null;
    const before = process.env.GITHUB_EVENT_BEFORE ?? '';
    const head = process.env.GITHUB_SHA ?? 'HEAD';
    if (isEmptyRevision(before)) return null;
    return { base: before, head };
  }

  return null;
}

function main() {
  const range = resolveRange();
  let files = null;

  if (range !== null) {
    try {
      files = git(['diff', '--name-only', '--no-renames', range.base, range.head])
        .split('\n')
        .filter((file) => file.length > 0);
    } catch (error) {
      console.warn(
        `changed-components: дифф ${range.base}..${range.head} не получен — собираем всё`,
      );
      console.warn(error instanceof Error ? error.message.split('\n')[0] : String(error));
    }
  }

  const result = files === null ? { api: true, web: true } : classify(files);

  if (files !== null) {
    console.log(`changed-components: изменено файлов ${files.length}`);
    for (const file of files) console.log(`  ${file}`);
    console.log(`changed-components: api=${result.api} web=${result.web}`);
  } else {
    console.log('changed-components: база для диффа недоступна — api=true web=true');
  }

  const include = [];
  if (result.api) include.push({ component: 'api', dockerfile: 'apps/api/Dockerfile' });
  if (result.web) include.push({ component: 'web', dockerfile: 'apps/web/Dockerfile' });

  const outputs = {
    api: String(result.api),
    web: String(result.web),
    any: String(result.api || result.web),
    matrix: JSON.stringify({ include }),
  };

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile === undefined) {
    console.log(`changed-components: ${JSON.stringify(outputs)}`);
    return;
  }

  for (const [key, value] of Object.entries(outputs)) {
    appendFileSync(outputFile, `${key}=${value}\n`, 'utf8');
  }
}

// Импорт для тестов не должен запускать CLI.
if (process.argv[1] !== undefined && process.argv[1].endsWith('changed-components.mjs')) main();
