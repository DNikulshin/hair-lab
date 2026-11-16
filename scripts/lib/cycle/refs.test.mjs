import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { parseRef, resolveRef } from './refs.mjs';

/** Образцы ссылок: формы, нераспознанные строки, запрещённые пути. */
const SAMPLES = JSON.parse(
  readFileSync(new URL('../../fixtures/cycle/refs.samples.json', import.meta.url), 'utf8'),
);

/**
 * Временное дерево файлов вместо реального репозитория.
 * @param {import('node:test').TestContext} t
 * @returns {string} корень дерева
 */
function makeRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'hair-lab-refs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, 'src'), { recursive: true });
  // Файл с завершающим переводом строки: три строки.
  writeFileSync(join(root, 'src', 'app.mjs'), 'alpha\nbeta\ngamma\n');
  // Файл без завершающего перевода строки: две строки, третьей нет.
  writeFileSync(join(root, 'src', 'no-newline.mjs'), 'alpha\nbeta');
  writeFileSync(join(root, 'src', 'empty.mjs'), '');
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  mkdirSync(join(root, '.pi', 'artifacts', '2026-11-16-1-slug'), { recursive: true });
  writeFileSync(join(root, '.pi', 'artifacts', '2026-11-16-1-slug', 'state.json'), '{}\n');
  // Файлы окружения: `.env.example` читать разрешено, остальные `.env*` — нет.
  writeFileSync(join(root, '.env.local'), 'DB_PASSWORD=example\nAPI_TOKEN=example\n');
  writeFileSync(join(root, '.env.example'), 'DB_PASSWORD=\nAPI_TOKEN=\n');
  mkdirSync(join(root, 'apps', 'api'), { recursive: true });
  writeFileSync(join(root, 'apps', 'api', '.env.production'), 'DB_PASSWORD=example\n');

  return root;
}

const GATES = { gates: [{ id: 'typecheck' }, { id: 'secrets_scan' }] };
const QA = { steps: [{ id: 's1' }, { id: 's2' }] };

/**
 * Создаёт символическую ссылку. Там, где их создать нельзя (Windows без прав), тест
 * помечается пропущенным, а не падает.
 * @param {import('node:test').TestContext} t
 * @param {string} target куда ссылается ссылка
 * @param {string} path путь самой ссылки
 * @returns {boolean} создана ли ссылка
 */
function linkOrSkip(t, target, path) {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    t.skip('создание символических ссылок недоступно');
    return false;
  }
}

describe('parseRef', () => {
  for (const sample of SAMPLES.parse) {
    test(`разбирает ${JSON.stringify(sample.ref)}`, () => {
      assert.deepEqual(parseRef(sample.ref), {
        kind: sample.kind,
        value: sample.value,
        line: sample.line,
      });
    });
  }

  for (const ref of SAMPLES.malformed) {
    test(`нераспознанная форма ${JSON.stringify(ref)} — ошибка`, () => {
      assert.throws(() => parseRef(ref), /ссылка: /);
    });
  }
});

describe('resolveRef: path:line', () => {
  test('строка внутри файла разрешается', (t) => {
    const root = makeRoot(t);

    const result = resolveRef('src/app.mjs:3', { root, gates: GATES, qa: QA });

    assert.equal(result.ok, true);
    assert.equal(result.kind, 'path');
    assert.equal(result.value, 'src/app.mjs');
    assert.equal(result.line, 3);
    assert.equal(result.file, join(root, 'src', 'app.mjs'));
    assert.equal(result.error, null);
  });

  test('файл без завершающего перевода строки: последняя строка — 2, третьей нет', (t) => {
    const root = makeRoot(t);

    assert.equal(resolveRef('src/no-newline.mjs:2', { root }).ok, true);
    const result = resolveRef('src/no-newline.mjs:3', { root });
    assert.equal(result.ok, false);
    assert.match(result.error, /строка 3 за концом файла src\/no-newline\.mjs \(строк: 2\)/);
  });

  test('файл с завершающим переводом строки не даёт ссылку на пустую строку N+1', (t) => {
    const root = makeRoot(t);

    assert.equal(resolveRef('src/app.mjs:3', { root }).ok, true);
    const result = resolveRef('src/app.mjs:4', { root });
    assert.equal(result.ok, false);
    assert.match(result.error, /\(строк: 3\)/);
  });

  test('пустой файл не содержит строк', (t) => {
    const root = makeRoot(t);

    const result = resolveRef('src/empty.mjs:1', { root });

    assert.equal(result.ok, false);
    assert.match(result.error, /\(строк: 0\)/);
  });

  test('нормализует `./` и повторные слэши', (t) => {
    const root = makeRoot(t);

    const result = resolveRef('./src//app.mjs:1', { root });

    assert.equal(result.ok, true);
    assert.equal(result.value, 'src/app.mjs');
  });

  for (const ref of SAMPLES.forbidden) {
    test(`запрещённая или отсутствующая ссылка ${JSON.stringify(ref)} не разрешается`, (t) => {
      const root = makeRoot(t);

      const result = resolveRef(ref, { root, gates: GATES, qa: QA });

      assert.equal(result.ok, false);
      assert.notEqual(result.error, null);
    });
  }

  test('абсолютный путь запрещён с понятной причиной', (t) => {
    const root = makeRoot(t);

    assert.match(resolveRef('/etc/passwd:1', { root }).error, /абсолютный путь запрещён/);
    assert.match(resolveRef('C:\\repo\\file.mjs:1', { root }).error, /обратные слэши/);
  });

  test('`..`, `.pi/artifacts/` и `node_modules/` запрещены по отдельности', (t) => {
    const root = makeRoot(t);

    assert.match(resolveRef('../secret.mjs:1', { root }).error, /«\.\.» в пути запрещён/);
    assert.match(
      resolveRef('.pi/artifacts/2026-11-16-1-slug/state.json:1', { root }).error,
      /путь в \.pi\/artifacts\/ запрещён/,
    );
    assert.match(
      resolveRef('node_modules/left-pad/index.js:1', { root }).error,
      /путь в node_modules\/ запрещён/,
    );
  });

  test('без корня репозитория путь не разрешается', (t) => {
    const root = makeRoot(t);

    assert.match(resolveRef('src/app.mjs:1', {}).error, /не задан корень репозитория/);
    assert.equal(resolveRef('src/app.mjs:1', { root }).ok, true);
  });

  test('каталог вместо файла — отказ, как и раньше', (t) => {
    const root = makeRoot(t);

    const result = resolveRef('src:1', { root });

    assert.equal(result.ok, false);
    assert.match(result.error, /не файл: src/);
  });

  test('`.env*` не читается ни в одном виде ссылки', (t) => {
    const root = makeRoot(t);

    // Прямой, вложенный и с `./`: любая форма не должна доходить до чтения файла.
    assert.match(
      resolveRef('.env.local:1', { root }).error,
      /чтение \.env\.local запрещено \(разрешён только \.env\.example\)/,
    );
    assert.match(
      resolveRef('apps/api/.env.production:1', { root }).error,
      /чтение \.env\.production запрещено/,
    );
    assert.match(resolveRef('./.env.local:1', { root }).error, /чтение \.env\.local запрещено/);
  });

  test('`.env.example` разрешён: номер строки проверяется по файлу', (t) => {
    const root = makeRoot(t);

    const result = resolveRef('.env.example:2', { root });

    assert.equal(result.ok, true);
    assert.equal(result.value, '.env.example');
    assert.equal(result.line, 2);
  });
});

describe('resolveRef: символические ссылки', () => {
  test('ссылка на файл вне репозитория не разрешается', (t) => {
    const root = makeRoot(t);
    const outside = mkdtempSync(join(tmpdir(), 'hair-lab-refs-outside-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'secret.txt'), 'one\ntwo\n');
    if (!linkOrSkip(t, join(outside, 'secret.txt'), join(root, 'linked.txt'))) return;

    const result = resolveRef('linked.txt:1', { root });

    assert.equal(result.ok, false);
    assert.equal(result.line, 1);
    assert.match(result.error, /путь выходит за пределы репозитория: linked\.txt/);
  });

  test('ссылка на файл внутри корня разрешается по каноническому пути', (t) => {
    const root = makeRoot(t);
    if (!linkOrSkip(t, join(root, 'src', 'app.mjs'), join(root, 'linked.txt'))) return;

    const result = resolveRef('linked.txt:2', { root });

    assert.equal(result.ok, true);
    assert.equal(result.value, 'linked.txt');
    assert.equal(result.line, 2);
  });

  test('ссылка в .pi/artifacts/ обходит запрет на область — отказ', (t) => {
    const root = makeRoot(t);
    const target = join(root, '.pi', 'artifacts', '2026-11-16-1-slug', 'state.json');
    if (!linkOrSkip(t, target, join(root, 'linked-state.json'))) return;

    const result = resolveRef('linked-state.json:1', { root });

    assert.equal(result.ok, false);
    assert.match(result.error, /символическая ссылка ведёт в запрещённый путь/);
  });

  test('ссылка на каталог вне корня не разрешается', (t) => {
    const root = makeRoot(t);
    const outside = mkdtempSync(join(tmpdir(), 'hair-lab-refs-outside-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    if (!linkOrSkip(t, outside, join(root, 'linked-dir'))) return;

    assert.equal(resolveRef('linked-dir:1', { root }).ok, false);
  });

  test('симлинк на `.env*` не обходит запрет', (t) => {
    const root = makeRoot(t);
    if (!linkOrSkip(t, join(root, '.env.local'), join(root, 'src', 'config.mjs'))) return;

    const result = resolveRef('src/config.mjs:1', { root });

    assert.equal(result.ok, false);
    assert.match(result.error, /символическая ссылка ведёт в запрещённый путь/);
  });
});

describe('resolveRef: gate и qa', () => {
  test('существующий гейт разрешается', () => {
    const result = resolveRef('gate:typecheck', { root: '/', gates: GATES, qa: QA });

    assert.equal(result.ok, true);
    assert.equal(result.kind, 'gate');
    assert.equal(result.value, 'typecheck');
    assert.equal(result.line, null);
  });

  test('отсутствующий гейт не разрешается', () => {
    const result = resolveRef('gate:not_a_gate', { root: '/', gates: GATES, qa: QA });

    assert.equal(result.ok, false);
    assert.match(result.error, /гейт не найден/);
  });

  test('`gates = null` — ссылка неразрешима', () => {
    const result = resolveRef('gate:typecheck', { root: '/', gates: null, qa: QA });

    assert.equal(result.ok, false);
    assert.match(result.error, /gates\.<n>\.json не передан/);
  });

  test('gates без массива `gates` — ссылка неразрешима', () => {
    const result = resolveRef('gate:typecheck', { root: '/', gates: { iteration: 1 } });

    assert.equal(result.ok, false);
    assert.match(result.error, /нет массива gates/);
  });

  test('существующий шаг QA разрешается, отсутствующий — нет', () => {
    assert.equal(resolveRef('qa:s2', { root: '/', qa: QA }).ok, true);
    assert.match(resolveRef('qa:s9', { root: '/', qa: QA }).error, /шаг не найден/);
    assert.match(resolveRef('qa:s2', { root: '/', qa: null }).error, /qa-web\.json не передан/);
  });

  test('нераспознанная ссылка возвращает отказ, а не исключение', () => {
    const result = resolveRef('gates:typecheck', { root: '/' });

    assert.equal(result.ok, false);
    assert.equal(result.kind, null);
    assert.match(result.error, /не распознана форма/);
    assert.equal(result.ref, 'gates:typecheck');
  });
});
