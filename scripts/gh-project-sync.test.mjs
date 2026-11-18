/**
 * Тесты `scripts/gh-project-sync.sh` (issue #280, #283).
 *
 * Скрипт разговаривает с GitHub только через `gh`, поэтому тест подставляет свой `gh`
 * в PATH: он отдаёт заранее заготовленные ответы, а любой вызов записи (`item-add`,
 * `item-edit`) валит прогон кодом 2. Так проверяется главное свойство: в режиме
 * `DRY_RUN=1` в проект не уходит ни одной записи.
 *
 * Доска читается GraphQL-снимком (#283), поэтому фикстура — это страницы ответа
 * `gh api graphql`: подставной `gh` отдаёт их по очереди, `page-0.json`, `page-1.json`, …
 * и упирается в отсутствующий файл, если скрипт запросил лишнюю страницу.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/** Проверяемый скрипт: запускается отдельным процессом через bash. */
const SCRIPT = fileURLToPath(new URL('./gh-project-sync.sh', import.meta.url));

/**
 * Подставной `gh`: чтение отдаёт фикстуры, запись — ошибку.
 * `--jq` эмулируется честно: фильтр берётся из аргументов и применяется к `issues.json`.
 */
const GH_SHIM = `#!/usr/bin/env bash
set -euo pipefail
case " $* " in
  *" api graphql "*)
    # Страницы отдаются по порядку: какой запрос по счёту — такой файл и читается.
    counter="$FIXTURES/page-counter"
    n=$(cat "$counter" 2>/dev/null || echo 0)
    echo $((n + 1)) > "$counter"
    cat "$FIXTURES/page-$n.json"
    ;;
  *" api user "*) echo "DNikulshin" ;;
  *" issue list "*)
    filter=""
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "--jq" ]; then filter="$arg"; fi
      prev="$arg"
    done
    jq -r "$filter" "$FIXTURES/issues.json"
    ;;
  *)
    echo "fake gh: запись в проект в этом тесте запрещена: $*" >&2
    exit 2
    ;;
esac
`;

/** Поле Status со всеми опциями доски. */
const STATUS_FIELD = {
  id: 'F_status',
  options: [
    { id: 'o_todo', name: 'Todo' },
    { id: 'o_in_progress', name: 'In progress' },
    { id: 'o_review', name: 'Review' },
    { id: 'o_blocked', name: 'Blocked' },
    { id: 'o_done', name: 'Done' },
  ],
};

/** Размер страницы, который запрашивает скрипт (`PAGE_SIZE`). */
const PAGE_SIZE = 100;

/**
 * @param {number} number
 * @param {'OPEN' | 'CLOSED'} state
 * @param {string[]} labels
 * @returns {object} issue в форме `gh issue list --json number,state,labels,url`
 */
function issue(number, state, labels = []) {
  return {
    number,
    state,
    labels: labels.map((name) => ({ name })),
    url: `https://github.com/DNikulshin/hair-lab/issues/${number}`,
  };
}

/**
 * @param {number} number
 * @param {string} status
 * @returns {object} карточка в форме `gh project item-list --format json`
 */
function card(number, status) {
  return {
    id: `PVTI_${number}`,
    content: { __typename: 'Issue', number },
    status: status === undefined ? null : { name: status },
  };
}

/**
 * Страницы ответа `gh api graphql` — по 100 карточек, как отдаёт GitHub.
 * @param {object[]} items
 * @param {number} totalCount
 * @returns {object[]}
 */
function pages(items, totalCount, statusField = STATUS_FIELD) {
  const result = [];
  for (let start = 0; start === 0 || start < items.length; start += PAGE_SIZE) {
    const slice = items.slice(start, start + PAGE_SIZE);
    const hasNext = start + PAGE_SIZE < items.length;
    result.push({
      data: {
        repositoryOwner: {
          projectV2: {
            id: 'PVT_test',
            statusField,
            items: {
              totalCount,
              pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? `c${start}` : null },
              nodes: slice,
            },
          },
        },
      },
    });
    if (!hasNext) break;
  }
  return result;
}

/**
 * Готовит каталог с фикстурами и подставным `gh`, запускает скрипт.
 * @param {{ issues: object[], items: object[], totalCount?: number, statusField?: object | null, env?: Record<string, string> }} options
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
function runSync({ issues, items, totalCount = items.length, statusField, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'hair-lab-board-'));
  try {
    const bin = join(dir, 'bin');
    const fixtures = join(dir, 'fixtures');
    mkdirSync(bin);
    mkdirSync(fixtures);

    const gh = join(bin, 'gh');
    writeFileSync(gh, GH_SHIM);
    chmodSync(gh, 0o755);

    writeFileSync(join(fixtures, 'issues.json'), JSON.stringify(issues));
    pages(items, totalCount, statusField === undefined ? STATUS_FIELD : statusField).forEach(
      (page, index) => {
        writeFileSync(join(fixtures, `page-${index}.json`), JSON.stringify(page));
      },
    );

    const result = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FIXTURES: fixtures,
        DRY_RUN: '1',
        ...env,
      },
    });
    assert.equal(result.error, undefined);
    return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('DRY_RUN показывает план и не пишет в проект', () => {
  const { code, stdout, stderr } = runSync({
    issues: [
      issue(10, 'OPEN', ['status:blocked']),
      issue(11, 'CLOSED'),
      issue(12, 'OPEN'),
      issue(13, 'OPEN', ['status:review', 'status:in-progress']),
    ],
    items: [card(10, 'Todo'), card(11, 'Done')],
  });

  // Код 0 — значит подставной `gh` не получил ни `item-add`, ни `item-edit`.
  assert.equal(code, 0, stderr);
  // Метка важнее колонки «по умолчанию»: blocked → Blocked.
  assert.match(stdout, /перенести\s+#10: Todo → Blocked/);
  // Закрытый issue уже в Done — трогать нечего.
  assert.doesNotMatch(stdout, /#11/);
  // Новой карточке колонка берётся из меток: нет метки → Todo.
  assert.match(stdout, /добавить\s+#12 → Todo/);
  // Из двух меток статуса побеждает in-progress (порядок проверок в скрипте).
  assert.match(stdout, /добавить\s+#13 → In progress/);
  assert.match(stdout, /добавлено 2, обновлено 1, без изменений 1/);
});

test('DRY_RUN на синхронной доске не предлагает изменений', () => {
  const { code, stdout } = runSync({
    issues: [issue(10, 'OPEN', ['status:todo']), issue(11, 'CLOSED')],
    items: [card(10, 'Todo'), card(11, 'Done')],
  });

  assert.equal(code, 0);
  assert.match(stdout, /добавлено 0, обновлено 0, без изменений 2/);
});

test('доска читается постранично, а `@me` резолвится в логин', () => {
  // Карточек больше одной страницы (PAGE_SIZE=100): их id со второй страницы тоже
  // должны попасть в снимок, иначе синк счёл бы их отсутствующими и задублировал.
  const items = Array.from({ length: PAGE_SIZE + 5 }, (_, index) => card(500 + index, 'Done'));
  const issues = [
    issue(10, 'OPEN', ['status:review']),
    ...items.map((item) => issue(item.content.number, 'CLOSED')),
  ];

  const { code, stdout, stderr } = runSync({ issues, items, env: { OWNER: '@me' } });

  assert.equal(code, 0, stderr);
  assert.match(stdout, /добавить\s+#10 → Review/);
  assert.match(stdout, new RegExp(`добавлено 1, обновлено 0, без изменений ${items.length}`));
});

test('без поля Status синк останавливается', () => {
  const { code, stderr } = runSync({ issues: [issue(10, 'OPEN')], items: [], statusField: null });

  assert.equal(code, 1);
  assert.match(stderr, /нет поля Status/);
});

test('усечение выдачи issues останавливает синк', () => {
  const { code, stderr } = runSync({
    issues: [issue(10, 'OPEN'), issue(11, 'OPEN'), issue(12, 'OPEN'), issue(13, 'OPEN')],
    items: [],
    env: { LIMIT: '4' },
  });

  assert.equal(code, 1);
  assert.match(stderr, /выдача усечена, синк отменён/);
});

test('усечение выдачи карточек останавливает синк', () => {
  const { code, stderr } = runSync({
    issues: [issue(10, 'OPEN')],
    items: [card(11, 'Done')],
    totalCount: 9,
    env: { LIMIT: '5' },
  });

  assert.equal(code, 1);
  assert.match(stderr, /На доске 9 карточек при LIMIT=5/);
});
