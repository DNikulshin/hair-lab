import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  dedupeUnverified,
  listItems,
  orderGates,
  parseArgs,
  parseCriteria,
  renderEscalationBanner,
  renderPrBody,
  summaryItems,
} from './cycle-pr-body.mjs';

/** Путь к CLI: тесты секций запускают его отдельным процессом, как супервизор. */
const SCRIPT = fileURLToPath(new URL('./cycle-pr-body.mjs', import.meta.url));

/** Каталог фикстур: `scripts/fixtures/cycle/pr-body/`. */
const FIXTURES = fileURLToPath(new URL('./fixtures/cycle/pr-body/', import.meta.url));

/** Корень репозитория: от него разрешаются ссылки `path:line` свидетельств. */
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * Запуск CLI в корне репозитория: ссылки фикстур должны разрешаться так же, как в цикле.
 * @param {string[]} args
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
}

/**
 * Каталог фикстуры.
 * @param {string} name имя каталога в `scripts/fixtures/cycle/pr-body/`
 * @returns {string}
 */
function dir(name) {
  return join(FIXTURES, name);
}

/**
 * Тело PR фикстуры, собранное CLI.
 * @param {string} name каталог фикстуры
 * @param {string[]} [args] дополнительные аргументы
 * @returns {string}
 */
function body(name, args = []) {
  const result = runCli(['--dir', dir(name), ...args]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/**
 * Разобранный JSON-артефакт фикстуры.
 * @param {string} name каталог фикстуры
 * @param {string} file имя файла
 * @returns {any}
 */
function fixtureJson(name, file) {
  return JSON.parse(readFileSync(join(dir(name), file), 'utf8'));
}

/**
 * Текст одной секции тела PR (от её заголовка до следующего `## `).
 * @param {string} text тело PR
 * @param {string} heading заголовок без `## `
 * @returns {string}
 */
function section(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  assert.notEqual(start, -1, `секция «${heading}» отсутствует`);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

/**
 * Входы `renderPrBody` в «всё зелёное» состояние.
 * @param {Record<string, any>} [overrides]
 * @returns {any}
 */
function inputs(overrides = {}) {
  return {
    state: { issue: 158, iteration: 1, max_iterations: 2 },
    gates: { gates: [] },
    review: { verdict: 'merge-ready', findings: [] },
    evaluation: {
      verdict: 'ACCEPT',
      criteria: [{ id: 'C1', status: 'met', evidence: [], note: '' }],
      defects: [],
      unverified: [],
    },
    decision: { action: 'PROCEED', unverified: [] },
    criteria: [{ id: 'C1', text: 'Критерий' }],
    summary: [],
    followups: [],
    escalation: null,
    root: REPO_ROOT,
    ...overrides,
  };
}

describe('секции шаблона', () => {
  test('«Что сделано» содержит Closes #N с номером из state.json и пункты артефактов', () => {
    const text = body('proceed');
    const state = fixtureJson('proceed', 'state.json');

    assert.match(text, new RegExp(`Closes #${state.issue}\\b`));
    assert.ok(
      text.includes('- Добавлен `scripts/cycle-pr-body.mjs`: тело PR в stdout'),
      'пункты «Что сделано» берутся из code-report.<n>.md',
    );
  });

  test('отчёт без раздела «Что сделано» — заглушка, а не «Расхождения с планом» (#249)', () => {
    const text = body('no-what-done');
    const done = section(text, 'Что сделано');

    assert.match(done, /Пункты «Что сделано» не найдены в `code-report\.1\.md`/);
    assert.equal(done.includes('Расхождения'), false, 'чужие пункты в «Что сделано» не едут');
    assert.equal(done.includes('Не проверено'), false);
    assert.match(done, new RegExp(`Closes #${fixtureJson('no-what-done', 'state.json').issue}\\b`));
  });

  test('все секции шаблона на месте и идут в его порядке', () => {
    const text = body('proceed');
    const headings = [
      '## Что сделано',
      '## Как проверять',
      '## Проверки',
      '## Независимая оценка',
      '## Риски',
      '## Вне скоупа',
    ].map((heading) => text.indexOf(heading));

    for (const [index, position] of headings.entries()) {
      assert.notEqual(position, -1, `секция ${index + 1} отсутствует`);
    }
    const sorted = [...headings].sort((left, right) => left - right);
    assert.deepEqual(headings, sorted, 'порядок секций должен совпадать с шаблоном');
  });

  test('«Проверки» берутся из gates.<n>.json, а не из статичного списка команд', () => {
    const text = body('proceed');

    assert.ok(text.includes('- [x] `contracts_build` — pass'));
    assert.ok(text.includes('- [x] `lint_workflows` — skipped (not_applicable)'));
    assert.ok(!text.includes('pnpm typecheck'), 'команды гейтов в PR не переписываются руками');
  });

  test('чекбокс `[x]` только у pass/skipped, у not_run — пустой с причиной', () => {
    const text = body('unverified');

    assert.ok(text.includes('- [x] `typecheck` — pass'));
    assert.ok(text.includes('- [x] `lint_workflows` — skipped (not_applicable)'));
    assert.ok(text.includes('- [ ] `test_int` — not_run (no_database)'));
  });

  test('строки «Проверок» идут в порядке таблицы §5.5, а не файла', () => {
    const text = body('proceed');
    // В фикстуре gates.1.json порядок другой: secrets_scan, test_scripts, contracts_build…
    const order = [
      'contracts_build',
      'typecheck',
      'lint_workflows',
      'test_scripts',
      'secrets_scan',
    ];
    const positions = order.map((id) => text.indexOf(`\`${id}\` —`));

    for (const position of positions) assert.notEqual(position, -1);
    assert.deepEqual(
      positions,
      [...positions].sort((left, right) => left - right),
    );
  });

  test('таблица критериев идёт в порядке criteria.md, со статусами и ссылками', () => {
    const text = body('proceed');
    // В evaluation.1.json критерии перечислены наоборот (C2, C1): порядок задаёт criteria.md.
    const first = text.indexOf('| C1: Тело PR содержит');
    const second = text.indexOf('| C2: Вывод детерминирован');

    assert.notEqual(first, -1);
    assert.notEqual(second, -1);
    assert.ok(first < second, 'C1 должен идти раньше C2');
    assert.ok(text.includes('| met | `scripts/lib/cycle/io.mjs:1` |'), 'ссылка path:line');
    assert.ok(text.includes('| met | `gate:contracts_build` |'), 'ссылка gate:<id>');
  });

  test('критерий без разрешаемой ссылки показывает примечание, а не выдуманное свидетельство', () => {
    const text = body('unverified');

    assert.ok(
      text.includes(
        '| C2: Пункты `followups.md` попадают в раздел «Вне скоупа». | partial | Нет кейса с пустым followups.md |',
      ),
    );
    assert.ok(
      text.includes('| C3: `pnpm test:int` выполнен на живой БД. | unverified | `gate:test_int` |'),
    );
  });

  test('partial и unverified перечислены отдельными строками', () => {
    const text = body('unverified');

    assert.ok(text.includes('Частично (`partial`): C2.'));
    assert.ok(text.includes('Не проверено (`unverified`): C3.'));
  });

  test('вердикты ревью и оценки стоят рядом, расхождение отмечено', () => {
    const text = body('unverified');

    assert.ok(text.includes('| Ревью | `needs-changes` |'));
    assert.ok(text.includes('| Оценка | `ACCEPT_WITH_FOLLOWUPS` |'));
    assert.ok(text.includes('Расхождение: ревью — `needs-changes`'));
    assert.ok(text.includes('Итераций: 1 из 2.'));
  });

  test('при совпадении знаков вердиктов строки расхождения нет', () => {
    const text = body('proceed');

    assert.ok(!text.includes('Расхождение:'));
  });

  test('«Вне скоупа» — пункты followups.md', () => {
    const text = body('proceed');

    assert.ok(
      text.includes('- Подключение вызова `cycle-pr-body` в протокол супервизора — задача T7.'),
    );
    assert.ok(text.includes('- Метрики цикла `cycle-metrics.mjs` — задача T8.'));
  });

  test('followups.md с тремя пунктами даёт три строки, без заглушки', () => {
    const lines = section(body('proceed'), 'Вне скоупа')
      .split('\n')
      .filter((line) => line.startsWith('- '));

    assert.equal(lines.length, 3, 'каждый пункт файла — отдельная строка');
    assert.ok(!lines.some((line) => line.includes('Нет пунктов вне скоупа')));
  });

  test('нет followups.md — заглушка, а не ошибка', () => {
    const text = body('escalation');

    assert.ok(text.includes('## Вне скоупа'));
    assert.ok(text.includes('Нет пунктов вне скоупа.'));
  });

  test('«Как проверять» перечисляет гейты, оставшиеся на человека', () => {
    assert.ok(body('unverified').includes('- `test_int` — not_run (no_database)'));
    assert.ok(body('proceed').includes('Все гейты пройдены или неприменимы: ручных шагов нет.'));
  });
});

describe('summaryItems: источник пунктов «Что сделано» (#249)', () => {
  const names = {
    codeReport: 'code-report.1.md',
    plan: 'plan.1.md',
    gates: 'gates.1.json',
    reviewMd: 'review.1.md',
    evaluationMd: 'evaluation.1.md',
    decision: 'decision.1.json',
  };

  /**
   * Временный каталог цикла с нужными файлами.
   * @param {Record<string, string>} files
   * @returns {string}
   */
  function cycleDir(files) {
    const dir = mkdtempSync(join(tmpdir(), 'hair-lab-pr-body-'));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }

  test('явный раздел «Что сделано» выигрывает у остальных', () => {
    const dir = cycleDir({
      'code-report.1.md': [
        '## Расхождения с планом',
        '- расхождение',
        '## Что сделано',
        '- сделано 1',
        '- сделано 2',
      ].join('\n'),
    });

    assert.deepEqual(summaryItems(dir, names), ['сделано 1', 'сделано 2']);
  });

  test('«Проверки» сразу после «Файлы» — не источник «Что сделано» (#267)', () => {
    const dir = cycleDir({
      'code-report.1.md': [
        '# Отчёт',
        '## Файлы',
        '- `scripts/a.mjs`',
        '## Проверки',
        '- `pnpm test:scripts` — 723 passed',
        '- `pnpm lint` — зелёный',
        '## Расхождения с планом',
        '- расхождение',
      ].join('\n'),
    });

    assert.deepEqual(summaryItems(dir, names), []);
  });

  test('«Не проверено» и «Вывод проверок» после «Файлы» — тоже не источник', () => {
    for (const heading of ['Не проверено', 'Вывод проверок (запускал супервизор)', 'Follow-ups']) {
      const dir = cycleDir({
        'code-report.1.md': [
          '## Изменённые файлы',
          '- `a.mjs`',
          `## ${heading}`,
          '- чужой пункт',
        ].join('\n'),
      });

      assert.deepEqual(summaryItems(dir, names), [], heading);
    }
  });

  test('нет подходящего раздела и нет «Файлы» — пустой список', () => {
    const dir = cycleDir({
      'code-report.1.md': '## Не проверено\n\n- не проверено\n',
    });

    assert.deepEqual(summaryItems(dir, names), []);
  });

  test('нет отчёта `code` — пункты берутся из плана', () => {
    const dir = cycleDir({ 'plan.1.md': '# План\n\n- шаг 1\n- шаг 2\n' });

    assert.deepEqual(summaryItems(dir, names), ['шаг 1', 'шаг 2']);
  });
});

describe('PROCEED_WITH_UNVERIFIED', () => {
  test('добавляет блок «не проверено» с чекбоксами для владельца', () => {
    const text = body('unverified');

    assert.ok(text.includes('### Не проверено (снять может владелец)'));
    assert.ok(
      text.includes('- [ ] gate:test_int not_run (no_database)'),
      'пункты decision.unverified',
    );
    assert.ok(
      text.includes('- [ ] Поведение на битом JSON артефакта — нет фикстуры с обрезанным файлом'),
      'пункты evaluation.unverified в форме what/why',
    );
  });

  test('при PROCEED блока «не проверено» нет', () => {
    assert.ok(!body('proceed').includes('### Не проверено'));
  });

  test('один и тот же факт из decision и evaluation — один чекбокс (#204)', () => {
    const text = body('unverified');
    const lines = text.split('\n').filter((line) => line.startsWith('- [ ]'));
    const entry = lines.filter((line) => line.includes('Поведение на битом JSON'));

    assert.equal(entry.length, 1, 'дубль из двух источников даёт один пункт');
    assert.ok(
      entry[0].includes('— нет фикстуры с обрезанным файлом'),
      'остаётся более полная версия (what — why)',
    );
    assert.ok(
      !text.includes('evaluation unverified: Поведение'),
      'префикс источника в тело PR не попадает',
    );
  });

  test('при ESCALATE блока «не проверено» нет', () => {
    assert.ok(!body('escalation').includes('### Не проверено'));
  });
});

describe('--draft-escalation', () => {
  test('баннер в начале: причина, пояснение, draft_pr_allowed и открытые замечания', () => {
    const text = body('escalation', ['--draft-escalation']);

    assert.ok(text.startsWith('> [!WARNING]\n'), 'баннер должен быть первым блоком тела');
    assert.ok(text.includes('> **Draft PR: эскалация `iteration_limit`.**'));
    assert.ok(text.includes('> Две итерации исчерпаны, остаётся BLOCKER R1'));
    assert.ok(text.includes('> Draft PR разрешён: да.'));
    assert.ok(text.includes('> - R1: маскирование не применяется к сводке находок'));
    assert.ok(text.includes('> - D1: в сообщении нет пути файла'));
  });

  test('без флага баннера нет', () => {
    assert.ok(!body('escalation').includes('> [!WARNING]'));
  });

  test('флаг без escalation.json — тела без баннера, код 0', () => {
    const result = runCli(['--dir', dir('proceed'), '--draft-escalation']);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('> [!WARNING]'));
  });

  test('draft_pr_allowed = false отображается как «нет»', () => {
    const banner = renderEscalationBanner({
      reason: 'budget',
      detail: null,
      draft_pr_allowed: false,
      open_items: [],
    });

    assert.ok(banner.includes('Draft PR разрешён: нет.'));
    assert.ok(!banner.includes('Открытые замечания'));
  });
});

describe('ПДн: тело PR уходит в публичный GitHub', () => {
  test('телефон и e-mail из артефактов маскируются', () => {
    const text = body('unverified');

    assert.ok(!text.includes('+79990000000'), 'телефон не должен попадать в тело PR');
    assert.ok(!text.includes('user@example.com'), 'e-mail не должен попадать в тело PR');
    assert.ok(text.includes('[phone]'));
    assert.ok(text.includes('[email]'));
  });

  test('баннер эскалации и followups.md тоже маскируются', () => {
    const escalated = body('escalation', ['--draft-escalation']);

    assert.ok(!escalated.includes('+79990000000'));
    assert.ok(!escalated.includes('support@example.com'));
    assert.ok(escalated.includes('> - Проверить адрес [email]'));
    assert.ok(body('unverified').includes('писать на [email]'));
  });

  test('неразрешимая ссылка свидетельства маскируется, а не печатается как есть', () => {
    const text = body('unresolved-pii');

    assert.ok(
      !text.includes('+7 999 000-00-00'),
      'телефон из evidence[] не должен попадать в тело PR',
    );
    assert.ok(
      !text.includes('support@example.com'),
      'e-mail из evidence[] не должен попадать в тело PR',
    );
    assert.ok(text.includes('| met | `[phone]` |'), 'ссылка-телефон маскируется в ячейке');
    assert.ok(text.includes('| met | `[email]` |'), 'ссылка-адрес маскируется в ячейке');
  });
});

describe('детерминизм', () => {
  test('два запуска CLI дают побайтно равный вывод', () => {
    for (const [name, args] of [
      ['proceed', []],
      ['unverified', []],
      ['escalation', ['--draft-escalation']],
    ]) {
      const first = body(name, args);
      const second = body(name, args);
      assert.equal(first, second, `${name}: тело PR должно собираться одинаково`);
    }
  });

  test('вывод не содержит абсолютных путей и завершается одним переводом строки', () => {
    const text = body('unverified');

    assert.ok(!text.includes(REPO_ROOT), 'абсолютные пути в тело PR не попадают');
    assert.ok(!text.includes(FIXTURES));
    assert.match(text, /[^\n]\n$/);
  });

  test('renderPrBody — чистая функция: одинаковые входы дают одинаковый текст', () => {
    const once = renderPrBody(inputs());
    assert.equal(once, renderPrBody(inputs()));
  });
});

describe('ошибки использования', () => {
  test('нет state.json — код 2 без стектрейса и без вывода', () => {
    const result = runCli(['--dir', FIXTURES]);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^cycle-pr-body: state\.json/u);
    assert.ok(!result.stderr.includes('node:internal'), 'стектрейс не печатается');
    for (const line of result.stderr.split('\n')) {
      assert.ok(!line.trimStart().startsWith('at '), `в stderr попал стектрейс: ${line}`);
    }
  });

  test('битый gates.<n>.json — код 2 с диагностикой схемы', () => {
    const result = runCli(['--dir', dir('broken-gates')]);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /gates\.1\.json: схема нарушена/u);
  });

  test('нет decision.<n>.json — код 2', () => {
    const result = runCli(['--dir', dir('no-decision')]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /decision\.1\.json/u);
  });

  test('неизвестный аргумент — код 2', () => {
    const result = runCli(['--wat']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /неизвестный аргумент: --wat/u);
  });

  test('критерий из criteria.md без статуса — код 2, пустой stdout, id в stderr', () => {
    const result = runCli(['--dir', dir('missing-criteria')]);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, '', 'частичное тело PR в stdout не пишется');
    assert.match(
      result.stderr,
      /^cycle-pr-body: evaluation\.criteria: нет статуса для критериев из criteria\.md: C1, C2/u,
      'отсутствующие id перечислены в порядке criteria.md',
    );
    assert.ok(!result.stderr.includes('node:internal'), 'стектрейс не печатается');
    for (const line of result.stderr.split('\n')) {
      assert.ok(!line.trimStart().startsWith('at '), `в stderr попал стектрейс: ${line}`);
    }
  });

  test('renderPrBody отвергает критерий без статуса, а не печатает «—»', () => {
    assert.throws(
      () =>
        renderPrBody(
          inputs({
            evaluation: { verdict: 'ACCEPT', criteria: [], defects: [], unverified: [] },
          }),
        ),
      /evaluation\.criteria: нет статуса для критериев из criteria\.md: C1/u,
    );
  });
});

describe('парсеры', () => {
  test('listItems снимает маркер и чекбокс, склеивает продолжение, закрывает пункт заголовком', () => {
    const items = listItems(
      [
        '# Вне скоупа',
        '',
        '- [ ] Первый пункт',
        '  продолжение пункта',
        '- Второй пункт',
        '',
        '## Раздел',
        '- Третий пункт',
      ].join('\n'),
    );

    assert.deepEqual(items, ['Первый пункт продолжение пункта', 'Второй пункт', 'Третий пункт']);
  });

  test('parseCriteria читает строки `- C1: …` в порядке файла', () => {
    const criteria = parseCriteria(
      [
        '# Критерии приёмки',
        '',
        'Источник: секция «Готово, когда».',
        '',
        '- C2: второй',
        '- C1: первый',
        '',
      ].join('\n'),
    );

    assert.deepEqual(criteria, [
      { id: 'C2', text: 'второй' },
      { id: 'C1', text: 'первый' },
    ]);
  });

  test('dedupeUnverified: префикс источника снимается, остаётся более полная формулировка', () => {
    const items = dedupeUnverified([
      'gate:test_int not_run (no_database)',
      'evaluation unverified: Поведение на битом JSON',
      'Поведение на битом JSON — нет фикстуры с обрезанным файлом',
      'criteria:C3 unverified',
      '  ',
    ]);

    assert.deepEqual(items, [
      'gate:test_int not_run (no_database)',
      'Поведение на битом JSON — нет фикстуры с обрезанным файлом',
      'criteria:C3 unverified',
    ]);
  });

  test('dedupeUnverified: повторное вхождение длиннее — заменяет короткое на своей позиции', () => {
    const items = dedupeUnverified(['Один факт', 'Другой факт', 'Один факт — с пояснением']);

    assert.deepEqual(items, ['Один факт — с пояснением', 'Другой факт']);
  });

  test('parseArgs: --dir и --draft-escalation, мусор — исключение', () => {
    assert.deepEqual(parseArgs([]), { dir: null, draftEscalation: false });
    assert.deepEqual(parseArgs(['--dir', 'D', '--draft-escalation']), {
      dir: 'D',
      draftEscalation: true,
    });
    assert.throws(() => parseArgs(['--dir']), /--dir: ожидается путь/u);
    assert.throws(() => parseArgs(['--dir', '--draft-escalation']), /--dir: ожидается путь/u);
    assert.throws(() => parseArgs(['--draft']), /неизвестный аргумент/u);
  });

  test('orderGates: известные id по таблице §5.5, неизвестные — после них по алфавиту', () => {
    const ordered = orderGates([
      { id: 'zz_custom' },
      { id: 'secrets_scan' },
      { id: 'aa_custom' },
      { id: 'contracts_build' },
    ]).map((gate) => gate.id);

    assert.deepEqual(ordered, ['contracts_build', 'secrets_scan', 'aa_custom', 'zz_custom']);
  });

  test('fail-гейт не получает чекбокс и показывает код выхода', () => {
    const text = renderPrBody(
      inputs({
        gates: {
          gates: [
            {
              id: 'lint',
              cmd: 'pnpm lint',
              required: true,
              status: 'fail',
              exit: 1,
              duration_s: 3,
              log: 'gates/lint.1.log',
              reason: null,
            },
          ],
        },
      }),
    );

    assert.ok(text.includes('- [ ] `lint` — fail (exit 1)'));
    assert.ok(text.includes('- `lint` — fail (exit 1)'));
  });

  test('gates без записей: раздел «Проверки» не выдумывает строки', () => {
    const text = renderPrBody(inputs());

    assert.ok(text.includes('Гейты не запускались.'));
    assert.ok(!text.includes('- [x]'));
  });
});
