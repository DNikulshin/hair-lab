import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import {
  countChangedLines,
  diffLimits,
  extractCriteria,
  parseArgs,
  parseListItems,
  parseSections,
  renderCriteria,
  renderIssue,
} from './cycle-evidence.mjs';
import { LIMITS } from './lib/cycle/config.mjs';

// Глобальный и системный конфиг git в тестах не нужен: он мог бы включить подпись
// коммитов, hooksPath или другую базовую ветку. Наследуется дочерними процессами.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

/** Путь к CLI: тесты запускают его как отдельный процесс. */
const SCRIPT = fileURLToPath(new URL('./cycle-evidence.mjs', import.meta.url));

/** Имя каталога цикла внутри `.pi/artifacts/` тестового репозитория. */
const CYCLE_DIR_NAME = '2026-11-16-155-cycle-evidence';

/**
 * Вымышленные ПДн и секреты (§4, только заглушки). Телефон и адрес не принадлежат
 * никому: домен `.invalid` зарезервирован, номер из документации. JWT и токен собраны
 * из частей, чтобы цельная секретоподобная строка не попала в добавленные строки
 * диффа — иначе её нашёл бы обязательный гейт `secrets_scan` (§5.5).
 */
const FAKE = Object.freeze({
  email: 'client@example.invalid',
  phone: '+7 (999) 123-45-67',
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ0ZXN0In0', 'c2lnbmF0dXJl'].join('.'),
  token: ['sk', 'live', '0123456789abcdef'].join('_'),
});

/**
 * Тело issue из секций формы `### <заголовок>`.
 * @param {[string, string][]} sections
 * @returns {string}
 */
function issueBody(sections) {
  return sections.map(([title, text]) => `### ${title}\n\n${text}\n`).join('\n');
}

/**
 * Запускает git в тестовом репозитории; ошибка — падение теста.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string} stdout без краевых переводов строки
 */
function gitRun(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * stdout git без обрезки: дифф сравнивается с файлом пакета построчно.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string}
 */
function gitRaw(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/**
 * Временный git-репозиторий с одним коммитом. `.pi/artifacts/` в `.gitignore` — как в
 * рабочем репозитории: иначе артефакты цикла попадали бы в дифф через intent-to-add.
 * Идентичность фиктивная: настоящие имя и адрес в тестах не нужны (§4, ПДн).
 * @param {import('node:test').TestContext} t
 * @returns {{ root: string, baseSha: string }}
 */
function makeRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'hair-lab-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const init = spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(init.status, 0, `git init: ${init.stderr}`);

  gitRun(root, ['config', 'user.name', 'Тестовый агент']);
  gitRun(root, ['config', 'user.email', 'test@example.invalid']);
  gitRun(root, ['config', 'commit.gpgsign', 'false']);

  writeFileSync(join(root, '.gitignore'), '.pi/artifacts/\n');
  writeFileSync(join(root, 'tracked.txt'), 'base\n');
  gitRun(root, ['add', '.gitignore', 'tracked.txt']);
  gitRun(root, ['commit', '--quiet', '-m', 'база']);

  return { root, baseSha: gitRun(root, ['rev-parse', 'HEAD']) };
}

/**
 * `state.json` тестового цикла в форме Приложения A.
 * @param {string} baseSha
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, unknown>}
 */
function stateDoc(baseSha, overrides = {}) {
  return {
    issue: 155,
    slug: 'cycle-evidence',
    branch: 'feat/155-cycle-evidence',
    base_sha: baseSha,
    iteration: 1,
    max_iterations: 2,
    stage: 'REVIEW',
    stage_status: 'done',
    criteria_source: 'issue',
    retries: { REVIEW: 0, EVALUATE: 0, evidence: 0 },
    owner_approved: false,
    models: { plan: 'vendor/plan', code: 'vendor/code', review: 'vendor/review' },
    history: [
      {
        stage: 'REVIEW',
        iteration: 1,
        started_at: '2026-11-16T09:00:00Z',
        finished_at: '2026-11-16T09:05:00Z',
        status: 'done',
      },
    ],
    escalation: null,
    started_at: '2026-11-16T09:00:00Z',
    updated_at: '2026-11-16T09:06:00Z',
    ...overrides,
  };
}

/**
 * Запись гейта в форме `gates.<n>.json`.
 * @param {string} id
 * @param {'pass'|'fail'|'skipped'|'not_run'} status
 * @param {{ log?: string|null }} [options]
 * @returns {Record<string, unknown>}
 */
function gate(id, status, { log = null } = {}) {
  return {
    id,
    cmd: `pnpm ${id}`,
    required: true,
    status,
    exit: status === 'pass' ? 0 : null,
    duration_s: 1,
    log,
    reason: null,
  };
}

/**
 * Документ `gates.<n>.json`.
 * @param {string} baseSha
 * @param {Record<string, unknown>[]} entries
 * @returns {Record<string, unknown>}
 */
function gatesDoc(baseSha, entries) {
  return {
    iteration: 1,
    base_sha: baseSha,
    head: 'HEAD',
    started_at: '2026-11-16T09:10:00Z',
    gates: entries,
  };
}

/**
 * Каталог цикла с артефактами. `criteria.md` по умолчанию уже собран: `packet`
 * выполняется после `criteria`.
 * @param {string} root
 * @param {{
 *   baseSha: string,
 *   state?: Record<string, unknown>|null,
 *   gates?: Record<string, unknown>|null,
 *   criteria?: string|null,
 *   qaWeb?: string|null,
 *   logs?: Record<string, string>,
 *   name?: string,
 * }} options
 * @returns {string} каталог цикла
 */
function makeCycleDir(root, options) {
  const { baseSha } = options;
  const dir = join(root, '.pi', 'artifacts', options.name ?? CYCLE_DIR_NAME);
  mkdirSync(dir, { recursive: true });

  const state = options.state === undefined ? stateDoc(baseSha) : options.state;
  if (state !== null) {
    writeFileSync(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  }

  const gates =
    options.gates === undefined ? gatesDoc(baseSha, [gate('lint', 'pass')]) : options.gates;
  if (gates !== null) {
    writeFileSync(join(dir, 'gates.1.json'), `${JSON.stringify(gates, null, 2)}\n`);
  }

  const criteria =
    options.criteria === undefined ? '# Критерии приёмки\n\n- C1: пример\n' : options.criteria;
  if (criteria !== null) {
    mkdirSync(join(dir, 'evidence'), { recursive: true });
    writeFileSync(join(dir, 'evidence', 'criteria.md'), criteria);
  }

  if (options.qaWeb !== undefined && options.qaWeb !== null) {
    writeFileSync(join(dir, 'qa-web.json'), options.qaWeb);
  }

  for (const [relative, text] of Object.entries(options.logs ?? {})) {
    const file = join(dir, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }

  return dir;
}

/**
 * Запускает CLI как отдельный процесс.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runCli(cwd, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

/**
 * Разобранная строка JSON из stdout CLI (единственная строка вывода).
 * @param {{ stdout: string }} result
 * @returns {Record<string, any>}
 */
function stdoutJson(result) {
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `ожидалась одна строка JSON, получено: ${result.stdout}`);
  return JSON.parse(lines[0]);
}

/**
 * Содержимое файла пакета `evidence/`.
 * @param {string} dir каталог цикла
 * @param {string} name имя файла внутри `evidence/`
 * @returns {string}
 */
function evidence(dir, name) {
  return readFileSync(join(dir, 'evidence', name), 'utf8');
}

/** Тело issue по форме feature: критерии в секции «Критерии приёмки». */
const FEATURE_ISSUE = Object.freeze({
  title: 'Запись на услугу без регистрации',
  body: issueBody([
    ['Цель', 'Клиент записывается без регистрации.'],
    ['Что входит в задачу', '- contracts: схема создания записи'],
    [
      'Критерии приёмки',
      '- повторная отправка формы не создаёт вторую запись\n- занятый слот возвращает slot_unavailable',
    ],
  ]),
  labels: ['type:feature', 'status:todo'],
});

describe('criteria: извлечение из форм issue', () => {
  test('feature: пункты списка становятся C1…Cn дословно', () => {
    const result = extractCriteria(FEATURE_ISSUE);

    assert.equal(result.ok, true);
    assert.equal(result.section, 'Критерии приёмки');
    assert.equal(result.template, 'feature');
    assert.deepEqual(result.criteria, [
      { id: 'C1', text: 'повторная отправка формы не создаёт вторую запись' },
      { id: 'C2', text: 'занятый слот возвращает slot_unavailable' },
    ]);
  });

  test('task: критерии берутся из «Готово, когда»', () => {
    const result = extractCriteria({
      title: 'CI',
      body: issueBody([
        ['Зачем', 'Проверки вручную.'],
        ['Готово, когда', '- пайплайн зелёный\n- прод обновлён, откат проверен'],
      ]),
      labels: [{ name: 'type:chore' }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.section, 'Готово, когда');
    assert.equal(result.template, 'task');
    assert.deepEqual(
      result.criteria.map((criterion) => criterion.text),
      ['пайплайн зелёный', 'прод обновлён, откат проверен'],
    );
  });

  test('_No response_ — пустое поле, критериев нет', () => {
    const result = extractCriteria({
      title: 'Пустая форма',
      body: issueBody([['Критерии приёмки', '_No response_']]),
      labels: ['type:feature'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'criteria_missing');
    assert.deepEqual(result.criteria, []);
    assert.match(/** @type {string} */ (result.detail), /пуста/);
  });

  test('нет секции критериев — criteria_missing', () => {
    const result = extractCriteria({
      title: 'Без критериев',
      body: issueBody([['Цель', 'Что-то сделать.']]),
      labels: ['type:feature'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'criteria_missing');
    assert.match(/** @type {string} */ (result.detail), /нет секции критериев/);
  });

  test('секция есть, но списка нет (проза) — criteria_missing', () => {
    const result = extractCriteria({
      title: 'Проза',
      body: issueBody([['Критерии приёмки', 'Работает как надо, проверено вручную.']]),
      labels: ['type:feature'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'criteria_missing');
    assert.match(/** @type {string} */ (result.detail), /нет элементов списка/);
  });

  test('пустое тело issue — criteria_missing', () => {
    const result = extractCriteria({ body: '', labels: ['type:feature'] });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'criteria_missing');
  });

  test('bug: список «Ожидаемый результат» даёт C1…Cn', () => {
    const result = extractCriteria({
      title: 'Двойная запись',
      body: issueBody([
        ['Шаги воспроизведения', '1. Открыть /booking'],
        ['Ожидаемый результат', '- вторая запись не создаётся\n- ответ 409 slot_unavailable'],
        ['Фактический результат', 'Создаются две записи.'],
      ]),
      labels: ['type:bug'],
    });

    assert.equal(result.ok, true);
    assert.equal(result.section, 'Ожидаемый результат');
    assert.equal(result.template, 'bug');
    assert.deepEqual(
      result.criteria.map((criterion) => criterion.text),
      ['вторая запись не создаётся', 'ответ 409 slot_unavailable'],
    );
  });

  test('bug: проза становится единственным C1 в одной строке', () => {
    const result = extractCriteria({
      title: 'Двойная запись',
      body: issueBody([
        ['Ожидаемый результат', 'Повторная отправка формы\nне создаёт вторую запись.'],
      ]),
      labels: ['type:bug'],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.criteria, [
      { id: 'C1', text: 'Повторная отправка формы не создаёт вторую запись.' },
    ]);
  });

  test('bug: пустой «Ожидаемый результат» — criteria_missing', () => {
    const result = extractCriteria({
      title: 'Двойная запись',
      body: issueBody([['Ожидаемый результат', '_No response_']]),
      labels: ['type:bug'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'criteria_missing');
  });

  test('type:bug поднимает «Ожидаемый результат» выше «Критериев приёмки»', () => {
    const body = issueBody([
      ['Критерии приёмки', '- feature-критерий'],
      ['Ожидаемый результат', '- ожидаемое поведение'],
    ]);

    const bug = extractCriteria({ title: 'Баг', body, labels: [{ name: 'type:bug' }] });
    const feature = extractCriteria({ title: 'Фича', body, labels: ['type:feature'] });

    assert.equal(bug.section, 'Ожидаемый результат');
    assert.deepEqual(
      bug.criteria.map((criterion) => criterion.text),
      ['ожидаемое поведение'],
    );
    assert.equal(feature.section, 'Критерии приёмки');
    assert.deepEqual(
      feature.criteria.map((criterion) => criterion.text),
      ['feature-критерий'],
    );
  });

  test('метки строками и объектами распознаются одинаково', () => {
    const body = issueBody([['Ожидаемый результат', '- ожидаемое поведение']]);

    assert.deepEqual(
      extractCriteria({ body, labels: [{ name: 'type:bug' }] }).criteria,
      extractCriteria({ body, labels: ['type:bug'] }).criteria,
    );
  });

  test('маркеры списка: `- [ ]`, `- [x]`, `* `, `1.` — все пункты', () => {
    const items = parseListItems(
      ['- [ ] первый', '- [x] второй', '* третий', '1. четвёртый', '-    пятый'].join('\n'),
    );

    assert.deepEqual(items, ['первый', 'второй', 'третий', 'четвёртый', 'пятый']);
  });

  test('строки без маркера до списка критериями не считаются, после пункта — продолжение', () => {
    assert.deepEqual(parseListItems('Проза\n---\n- пункт\n  продолжение'), ['пункт продолжение']);
  });

  test('пункт с продолжением в две строки — один критерий с полным текстом', () => {
    assert.deepEqual(parseListItems('- Требование:\n   и его важное продолжение'), [
      'Требование: и его важное продолжение',
    ]);

    const result = extractCriteria({
      title: 'Многострочный критерий',
      body: issueBody([
        ['Критерии приёмки', '- Требование:\n  и его важное продолжение\n- второй пункт'],
      ]),
      labels: ['type:feature'],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.criteria, [
      { id: 'C1', text: 'Требование: и его важное продолжение' },
      { id: 'C2', text: 'второй пункт' },
    ]);
  });

  test('несколько строк продолжения склеиваются через один пробел', () => {
    assert.deepEqual(parseListItems('- первая\n  вторая\n\tтретья\n- другой'), [
      'первая вторая третья',
      'другой',
    ]);
  });

  test('пустая строка завершает пункт: пункты не склеиваются', () => {
    assert.deepEqual(parseListItems('- первый\n\n- второй'), ['первый', 'второй']);
  });

  test('абзац после списка, отделённый пустой строкой, критерием не становится', () => {
    assert.deepEqual(parseListItems('- пункт\n\nАбзац после списка.'), ['пункт']);
  });

  test('секции разбираются до следующего `###`', () => {
    const sections = parseSections(
      ['### Первая', '', 'текст', '### Вторая', '', '- a', '#### Не заголовок формы'].join('\n'),
    );

    assert.deepEqual(sections, [
      { title: 'Первая', text: 'текст' },
      { title: 'Вторая', text: '- a\n#### Не заголовок формы' },
    ]);
  });
});

describe('criteria: CLI', () => {
  test('пишет issue.md и criteria.md и печатает строку JSON', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycleDir(root, { baseSha });
    writeFileSync(join(dir, 'issue.json'), `${JSON.stringify(FEATURE_ISSUE, null, 2)}\n`);

    const result = runCli(root, ['criteria', '--dir', dir]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(stdoutJson(result), {
      command: 'criteria',
      criteria: ['C1', 'C2'],
      files: ['evidence/issue.md', 'evidence/criteria.md'],
      section: 'Критерии приёмки',
      template: 'feature',
    });

    assert.equal(evidence(dir, 'issue.md'), `# ${FEATURE_ISSUE.title}\n\n${FEATURE_ISSUE.body}`);
    assert.equal(
      evidence(dir, 'criteria.md'),
      [
        '# Критерии приёмки',
        '',
        'Источник: секция «Критерии приёмки» (шаблон feature).',
        '',
        '- C1: повторная отправка формы не создаёт вторую запись',
        '- C2: занятый слот возвращает slot_unavailable',
        '',
      ].join('\n'),
    );
  });

  test('два прогона дают побайтно одинаковые файлы', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycleDir(root, { baseSha });
    writeFileSync(join(dir, 'issue.json'), `${JSON.stringify(FEATURE_ISSUE, null, 2)}\n`);

    assert.equal(runCli(root, ['criteria', '--dir', dir]).status, 0);
    const first = [evidence(dir, 'issue.md'), evidence(dir, 'criteria.md')];
    assert.equal(runCli(root, ['criteria', '--dir', dir]).status, 0);

    assert.deepEqual([evidence(dir, 'issue.md'), evidence(dir, 'criteria.md')], first);
  });

  test('issue-json берётся из каталога цикла по умолчанию', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycleDir(root, { baseSha });
    writeFileSync(join(dir, 'issue.json'), `${JSON.stringify(FEATURE_ISSUE, null, 2)}\n`);

    assert.equal(runCli(root, ['criteria', '--dir', dir]).status, 0);
    assert.match(evidence(dir, 'criteria.md'), /- C1: повторная отправка/);
  });

  test('_No response_ — код 2, criteria_missing в stdout, файлов нет', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycleDir(root, { baseSha });
    const issue = {
      title: 'Пустая форма',
      body: issueBody([['Критерии приёмки', '_No response_']]),
      labels: ['type:feature'],
    };
    writeFileSync(join(dir, 'issue.json'), `${JSON.stringify(issue, null, 2)}\n`);

    const result = runCli(root, ['criteria', '--dir', dir]);

    assert.equal(result.status, 2);
    assert.deepEqual(stdoutJson(result), { command: 'criteria', reason: 'criteria_missing' });
    assert.match(result.stderr, /criteria_missing/);
    assert.equal(existsSync(join(dir, 'evidence', 'issue.md')), false);
    // Ранее собранный criteria.md не перезаписывается при отказе.
    assert.match(evidence(dir, 'criteria.md'), /- C1: пример/);
  });

  test('битый issue.json и отсутствие title — код 2', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycleDir(root, { baseSha });

    writeFileSync(join(dir, 'issue.json'), '{"title":');
    const broken = runCli(root, ['criteria', '--dir', dir]);
    assert.equal(broken.status, 2);
    assert.match(broken.stderr, /issue\.json/);

    writeFileSync(
      join(dir, 'issue.json'),
      JSON.stringify({ body: FEATURE_ISSUE.body, labels: [] }),
    );
    const untitled = runCli(root, ['criteria', '--dir', dir]);
    assert.equal(untitled.status, 2);
    assert.match(untitled.stderr, /title/);

    assert.equal(existsSync(join(dir, 'evidence', 'issue.md')), false);
  });

  test('мусор в аргументах — код 2', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycleDir(root, { baseSha });

    for (const args of [
      ['criteria', '--dir', dir, '--base', 'main'],
      ['criteria', '--dir', dir, '--nope'],
      ['criteria', '--dir'],
      ['packet', '--dir'],
      ['report'],
    ]) {
      assert.equal(runCli(root, args).status, 2, `аргументы: ${args.join(' ')}`);
    }
    assert.deepEqual(parseArgs(['criteria', '--dir', 'd']), {
      command: 'criteria',
      dir: 'd',
      issueJson: null,
      base: null,
    });
  });
});

describe('CLI: ограничение --dir (§4)', () => {
  test('каталог внутри репозитория вне .pi/artifacts — код 2, файлы не создаются', (t) => {
    const { root, baseSha } = makeRepo(t);
    const forbidden = join(root, 'apps', 'web');
    mkdirSync(forbidden, { recursive: true });
    writeFileSync(join(forbidden, 'issue.json'), `${JSON.stringify(FEATURE_ISSUE, null, 2)}\n`);

    const criteria = runCli(root, ['criteria', '--dir', forbidden]);

    assert.equal(criteria.status, 2, criteria.stderr);
    assert.match(criteria.stderr, /\.pi\/artifacts/, criteria.stderr);
    assert.ok(
      criteria.stderr.includes(forbidden),
      `в stderr ожидался путь каталога: ${criteria.stderr}`,
    );
    assert.equal(existsSync(join(forbidden, 'evidence')), false);

    const packet = runCli(root, ['packet', '--dir', forbidden]);
    assert.equal(packet.status, 2, packet.stderr);
    assert.match(packet.stderr, /\.pi\/artifacts/, packet.stderr);
    assert.equal(existsSync(join(forbidden, 'evidence')), false);

    // Каталог цикла в `.pi/artifacts/` работает как раньше: обе подкоманды дают код 0.
    const cycle = makeCycleDir(root, { baseSha });
    writeFileSync(join(cycle, 'issue.json'), `${JSON.stringify(FEATURE_ISSUE, null, 2)}\n`);
    assert.equal(runCli(root, ['criteria', '--dir', cycle]).status, 0);
    assert.equal(runCli(root, ['packet', '--dir', cycle]).status, 0);
  });

  test('симлинк из .pi/artifacts/ наружу — код 2, вне репозитория ничего не создаётся', (t) => {
    const { root } = makeRepo(t);
    const outside = mkdtempSync(join(tmpdir(), 'hair-lab-evidence-escape-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'issue.json'), `${JSON.stringify(FEATURE_ISSUE, null, 2)}\n`);

    const link = join(root, '.pi', 'artifacts', 'link');
    mkdirSync(join(root, '.pi', 'artifacts'), { recursive: true });
    try {
      symlinkSync(outside, link);
    } catch {
      t.skip('создание символических ссылок недоступно');
      return;
    }

    const result = runCli(root, ['criteria', '--dir', link]);

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /\.pi\/artifacts/, result.stderr);
    assert.equal(existsSync(join(outside, 'evidence')), false);
  });

  test('.pi/artifacts — симлинк наружу: --dir внутри него отвергается', (t) => {
    const { root } = makeRepo(t);
    const outside = mkdtempSync(join(tmpdir(), 'hair-lab-evidence-artifacts-link-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    mkdirSync(join(outside, 'cycle'), { recursive: true });
    writeFileSync(
      join(outside, 'cycle', 'issue.json'),
      `${JSON.stringify(FEATURE_ISSUE, null, 2)}\n`,
    );

    // Весь каталог артефактов репозитория уводим симлинком наружу.
    mkdirSync(join(root, '.pi'), { recursive: true });
    try {
      symlinkSync(outside, join(root, '.pi', 'artifacts'));
    } catch {
      t.skip('создание символических ссылок недоступно');
      return;
    }

    const lexical = join(root, '.pi', 'artifacts', 'cycle');
    const result = runCli(root, ['criteria', '--dir', lexical]);

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /символическая ссылка недопустима/, result.stderr);
    assert.equal(existsSync(join(outside, 'cycle', 'evidence')), false);
  });

  test('симлинк из /tmp внутрь репозитория вне .pi/artifacts — тоже код 2', (t) => {
    const { root } = makeRepo(t);
    const outside = mkdtempSync(join(tmpdir(), 'hair-lab-evidence-indirect-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    const target = join(root, 'apps', 'web');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'issue.json'), `${JSON.stringify(FEATURE_ISSUE, null, 2)}\n`);

    const link = join(outside, 'link');
    try {
      symlinkSync(target, link);
    } catch {
      t.skip('создание символических ссылок недоступно');
      return;
    }

    const result = runCli(root, ['criteria', '--dir', link]);

    assert.equal(result.status, 2, result.stderr);
    assert.equal(existsSync(join(target, 'evidence')), false);
  });

  test('каталог вне корня репозитория разрешён (smoke на временном каталоге)', (t) => {
    const { root } = makeRepo(t);
    const outside = mkdtempSync(join(tmpdir(), 'hair-lab-evidence-outside-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'issue.json'), `${JSON.stringify(FEATURE_ISSUE, null, 2)}\n`);

    const result = runCli(root, ['criteria', '--dir', outside]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(outside, 'evidence', 'criteria.md')), true);
  });
});

describe('packet: дифф от базы', () => {
  test('untracked-файл виден только после intent-to-add, и тогда попадает в diff.patch', (t) => {
    const { root, baseSha } = makeRepo(t);
    writeFileSync(join(root, 'tracked.txt'), 'base\nchanged\n');
    writeFileSync(join(root, 'new.txt'), 'новый файл\n');

    // Без intent-to-add нового файла в диффе нет — это Blind spot §4.
    assert.doesNotMatch(gitRaw(root, ['diff', '--no-color', baseSha, '--']), /new\.txt/);

    const dir = makeCycleDir(root, { baseSha });
    const result = runCli(root, ['packet', '--dir', dir]);

    assert.equal(result.status, 0, result.stderr);
    const patch = evidence(dir, 'diff.patch');
    assert.match(patch, /new\.txt/);
    assert.match(patch, /\+новый файл/);
    assert.match(patch, /\+changed/);
  });

  test('дифф строится от base_sha, а не от main', (t) => {
    const { root, baseSha } = makeRepo(t);

    // main уходит вперёд: коммит, которого нет на ветке цикла.
    gitRun(root, ['checkout', '--quiet', '-b', 'feature']);
    gitRun(root, ['checkout', '--quiet', 'main']);
    writeFileSync(join(root, 'main-only.txt'), 'только в main\n');
    gitRun(root, ['add', 'main-only.txt']);
    gitRun(root, ['commit', '--quiet', '-m', 'main вперёд']);
    const mainSha = gitRun(root, ['rev-parse', 'HEAD']);
    gitRun(root, ['checkout', '--quiet', 'feature']);

    writeFileSync(join(root, 'tracked.txt'), 'base\nchanged\n');
    const dir = makeCycleDir(root, { baseSha });

    const result = runCli(root, ['packet', '--dir', dir]);
    assert.equal(result.status, 0, result.stderr);

    const patch = evidence(dir, 'diff.patch');
    assert.match(patch, /\+changed/);
    assert.doesNotMatch(patch, /main-only/, 'дифф не должен считаться от main');
    // От main дифф отличался бы: файл из main выглядел бы удалённым.
    assert.match(gitRaw(root, ['diff', '--no-color', 'main', '--']), /main-only/);
    assert.notEqual(mainSha, baseSha);
  });

  test('база гейтов приоритетнее state, а --base переопределяет обе', (t) => {
    const { root, baseSha } = makeRepo(t);
    // Коммит после базы: он попадёт в дифф от базы и исчезнет из диффа от новой базы.
    writeFileSync(join(root, 'later.txt'), 'после базы\n');
    gitRun(root, ['add', 'later.txt']);
    gitRun(root, ['commit', '--quiet', '-m', 'после базы']);
    const laterSha = gitRun(root, ['rev-parse', 'HEAD']);

    const dir = makeCycleDir(root, {
      baseSha,
      state: stateDoc(laterSha),
      gates: gatesDoc(baseSha, [gate('lint', 'pass')]),
    });

    const fromGates = runCli(root, ['packet', '--dir', dir]);
    assert.equal(fromGates.status, 0, fromGates.stderr);
    assert.match(evidence(dir, 'diff.patch'), /\+после базы/);
    assert.equal(stdoutJson(fromGates).base_sha, baseSha);

    const overridden = runCli(root, ['packet', '--dir', dir, '--base', laterSha]);
    assert.equal(overridden.status, 0, overridden.stderr);
    assert.doesNotMatch(evidence(dir, 'diff.patch'), /после базы/);
    assert.equal(stdoutJson(overridden).base_sha, laterSha);
  });

  test('нерезолвящаяся база — код 2 и никаких файлов', (t) => {
    const { root, baseSha } = makeRepo(t);
    writeFileSync(join(root, 'tracked.txt'), 'base\nchanged\n');
    const dir = makeCycleDir(root, { baseSha });

    const result = runCli(root, ['packet', '--dir', dir, '--base', 'no-such-ref']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /base/);
    assert.equal(existsSync(join(dir, 'evidence', 'diff.patch')), false);
  });
});

describe('packet: лимиты диффа', () => {
  /**
   * Синтетический дифф из `count` добавленных строк одного файла.
   * @param {number} count
   * @returns {string}
   */
  function syntheticDiff(count) {
    return [
      'diff --git a/big.txt b/big.txt',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/big.txt',
      `@@ -0,0 +1,${count} @@`,
      ...Array.from({ length: count }, () => '+строка'),
      '',
    ].join('\n');
  }

  test('countChangedLines не считает заголовки `+++`/`---` и контекст', () => {
    const diff = [
      'diff --git a/notes.txt b/notes.txt',
      'index 1111111..2222222 100644',
      '--- a/notes.txt',
      '+++ b/notes.txt',
      '@@ -1,3 +1,4 @@',
      ' context',
      '-removed',
      '+added',
      '++plus content',
      '\\ No newline at end of file',
    ].join('\n');

    assert.equal(countChangedLines(diff), 3);
    assert.equal(countChangedLines(''), 0);
  });

  test('граница лимита строк: 2000 — успех, 2001 — превышение', () => {
    assert.equal(LIMITS.maxDiffLines, 2000);
    assert.equal(diffLimits(syntheticDiff(2000)).lines, 2000);
    assert.equal(diffLimits(syntheticDiff(2000)).tooLarge, false);
    assert.equal(diffLimits(syntheticDiff(2001)).tooLarge, true);
  });

  test('превышение по байтам — тоже слишком большой дифф', () => {
    const huge = `@@ -0,0 +1,1 @@\n+${'x'.repeat(LIMITS.maxDiffBytes + 1)}\n`;

    assert.equal(diffLimits(huge).lines, 1);
    assert.equal(diffLimits(huge).tooLarge, true);
  });

  test('2001 изменённая строка — код 4, diff.patch не пишется', (t) => {
    const { root, baseSha } = makeRepo(t);
    writeFileSync(join(root, 'big.txt'), `${'строка\n'.repeat(2001)}`);
    const dir = makeCycleDir(root, { baseSha });

    const result = runCli(root, ['packet', '--dir', dir]);

    assert.equal(result.status, 4, result.stderr);
    const doc = stdoutJson(result);
    assert.equal(doc.reason, 'diff_too_large');
    assert.equal(doc.command, 'packet');
    assert.ok(doc.lines >= 2001, `строк: ${doc.lines}`);
    assert.ok(doc.bytes > 0);
    assert.equal(existsSync(join(dir, 'evidence', 'diff.patch')), false);
    assert.equal(existsSync(join(dir, 'evidence', 'gates.json')), false);
  });

  test('ровно 2000 изменённых строк — код 0', (t) => {
    const { root, baseSha } = makeRepo(t);
    writeFileSync(join(root, 'big.txt'), `${'строка\n'.repeat(2000)}`);
    const dir = makeCycleDir(root, { baseSha });

    const result = runCli(root, ['packet', '--dir', dir]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(stdoutJson(result).lines, 2000);
    assert.match(evidence(dir, 'diff.patch'), /\+строка/);
  });

  test('одна строка больше лимита байт — код 4', (t) => {
    const { root, baseSha } = makeRepo(t);
    writeFileSync(join(root, 'huge.txt'), `${'x'.repeat(LIMITS.maxDiffBytes + 1024)}\n`);
    const dir = makeCycleDir(root, { baseSha });

    const result = runCli(root, ['packet', '--dir', dir]);

    assert.equal(result.status, 4, result.stderr);
    assert.equal(stdoutJson(result).reason, 'diff_too_large');
    assert.equal(existsSync(join(dir, 'evidence', 'diff.patch')), false);
  });
});

describe('packet: пакет evidence/', () => {
  /**
   * Лог гейта на 250 строк: каждые 50 строк — вымышленные ПДн или секрет.
   * @param {number} count
   * @returns {string}
   */
  function gateLog(count) {
    // Присвоение токена собирается из частей: цельная секретоподобная строка в исходнике
    // теста сработала бы на обязательном гейте `secrets_scan` (§5.5).
    const tokenLine = ['token', FAKE.token].join('=');
    const lines = Array.from({ length: count }, (_, index) => {
      const number = index + 1;
      if (number === 60) return `строка ${number}: написать на ${FAKE.email}`;
      if (number === 100) return `строка ${number}: телефон ${FAKE.phone}`;
      if (number === 150) return `строка ${number}: токен ${FAKE.jwt}`;
      if (number === 200) return `строка ${number}: ${tokenLine}`;
      return `строка ${number}: ok`;
    });
    return `${lines.join('\n')}\n`;
  }

  test('копирует gates.json байт-в-байт, хвост лога упавшего гейта и не копирует pass', (t) => {
    const { root, baseSha } = makeRepo(t);
    const log = gateLog(250);
    const dir = makeCycleDir(root, {
      baseSha,
      gates: gatesDoc(baseSha, [
        gate('lint', 'fail', { log: 'gates/lint.1.log' }),
        gate('typecheck', 'pass', { log: 'gates/typecheck.1.log' }),
        gate('secrets_scan', 'pass'),
      ]),
      logs: { 'gates/lint.1.log': log, 'gates/typecheck.1.log': gateLog(3) },
    });

    const result = runCli(root, ['packet', '--dir', dir]);
    assert.equal(result.status, 0, result.stderr);

    const gatesSource = readFileSync(join(dir, 'gates.1.json'), 'utf8');
    assert.equal(evidence(dir, 'gates.json'), gatesSource);

    const tailed = evidence(dir, join('gates', 'lint.1.log'));
    const lines = tailed.replace(/\n$/, '').split('\n');
    assert.equal(lines.length, LIMITS.evidenceTailLines);
    assert.equal(lines[0], 'строка 51: ok');
    assert.equal(lines.at(-1), 'строка 250: ok');
    assert.deepEqual(readdirSync(join(dir, 'evidence', 'gates')), ['lint.1.log']);
  });

  test('в хвосте лога замаскированы e-mail, телефон, JWT и присвоение токена', (t) => {
    const { root, baseSha } = makeRepo(t);
    const dir = makeCycleDir(root, {
      baseSha,
      gates: gatesDoc(baseSha, [gate('lint', 'fail', { log: 'gates/lint.1.log' })]),
      logs: { 'gates/lint.1.log': gateLog(250) },
    });

    assert.equal(runCli(root, ['packet', '--dir', dir]).status, 0);

    const tailed = evidence(dir, join('gates', 'lint.1.log'));
    assert.match(tailed, /\[email\]/);
    assert.match(tailed, /\[phone\]/);
    assert.match(tailed, /токен \[secret\]/);
    assert.equal(tailed.includes('строка 200: token=[secret]'), true);
    for (const secret of [FAKE.email, FAKE.phone, FAKE.jwt, FAKE.token]) {
      assert.equal(tailed.includes(secret), false, `не замаскировано: ${secret}`);
    }
  });

  test('лог-симлинк за пределы каталога цикла в пакет не попадает', (t) => {
    const { root, baseSha } = makeRepo(t);
    writeFileSync(join(root, 'tracked.txt'), 'base\nchanged\n');

    const outside = mkdtempSync(join(tmpdir(), 'hair-lab-evidence-outside-'));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'leak.log'), 'внешний лог: утечка\n');

    const dir = makeCycleDir(root, {
      baseSha,
      gates: gatesDoc(baseSha, [
        gate('lint', 'fail', { log: 'gates/lint.1.log' }),
        gate('leak', 'fail', { log: 'gates/leak.log' }),
      ]),
      logs: { 'gates/lint.1.log': 'падение линтера\n' },
    });
    // `gates/leak.log` ведёт на файл вне каталога цикла: читать его нельзя.
    symlinkSync(join(outside, 'leak.log'), join(dir, 'gates', 'leak.log'));

    const result = runCli(root, ['packet', '--dir', dir]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(join(dir, 'evidence', 'gates')), ['lint.1.log']);
    assert.equal(existsSync(join(dir, 'evidence', 'gates', 'leak.1.log')), false);
    assert.equal(stdoutJson(result).files.includes('evidence/gates/leak.1.log'), false);
    assert.doesNotMatch(evidence(dir, join('gates', 'lint.1.log')), /утечка/);
  });

  test('лог-симлинк внутри каталога цикла читается как обычный файл', (t) => {
    const { root, baseSha } = makeRepo(t);
    writeFileSync(join(root, 'tracked.txt'), 'base\nchanged\n');
    const dir = makeCycleDir(root, {
      baseSha,
      gates: gatesDoc(baseSha, [gate('lint', 'fail', { log: 'gates/link.log' })]),
      logs: { 'gates/real.log': 'внутренний лог\n' },
    });
    symlinkSync('real.log', join(dir, 'gates', 'link.log'));

    const result = runCli(root, ['packet', '--dir', dir]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(evidence(dir, join('gates', 'lint.1.log')), 'внутренний лог\n');
  });

  test('qa-web.json маскируется, id и структура шагов сохраняются', (t) => {
    const { root, baseSha } = makeRepo(t);
    const qaWeb = {
      status: 'done',
      reason: null,
      steps: [
        {
          id: 's1',
          url: 'http://127.0.0.1:3003/booking',
          action: 'отправить форму',
          observed: `в консоли ошибка, контакт ${FAKE.email}`,
          console_errors: [`телефон ${FAKE.phone}`],
          failed_requests: [],
          cache_headers: null,
        },
      ],
    };
    const dir = makeCycleDir(root, {
      baseSha,
      qaWeb: `${JSON.stringify(qaWeb, null, 2)}\n`,
    });

    const result = runCli(root, ['packet', '--dir', dir]);
    assert.equal(result.status, 0, result.stderr);

    const copied = JSON.parse(evidence(dir, 'qa-web.json'));
    assert.equal(copied.status, 'done');
    assert.equal(copied.steps.length, 1);
    assert.equal(copied.steps[0].id, 's1');
    assert.equal(copied.steps[0].url, qaWeb.steps[0].url);
    assert.equal(copied.steps[0].action, qaWeb.steps[0].action);
    assert.match(copied.steps[0].observed, /\[email\]/);
    assert.equal(copied.steps[0].console_errors[0], 'телефон [phone]');
  });

  test('в diff.patch маскируются контакты, а sha, UUID и номера строк не меняются', (t) => {
    const { root, baseSha } = makeRepo(t);
    const uuid = '8f14e45f-ceea-467f-a8d5-1b2f7c0e3a11';
    writeFileSync(
      join(root, 'tracked.txt'),
      ['base', `contact: ${FAKE.email}`, `id: ${uuid}`, `phone ${FAKE.phone}`, ''].join('\n'),
    );
    const dir = makeCycleDir(root, { baseSha });

    assert.equal(runCli(root, ['packet', '--dir', dir]).status, 0);

    const raw = gitRaw(root, ['diff', '--no-color', baseSha, '--']);
    const patch = evidence(dir, 'diff.patch');

    assert.match(patch, /\[email\]/);
    assert.match(patch, /\[phone\]/);
    for (const secret of [FAKE.email, FAKE.phone]) {
      assert.equal(patch.includes(secret), false, `не замаскировано: ${secret}`);
    }
    // Структура диффа и нумерация строк не изменились.
    assert.equal(patch.split('\n').length, raw.split('\n').length);
    const hunks = (text) => text.split('\n').filter((line) => line.startsWith('@@'));
    assert.deepEqual(hunks(patch), hunks(raw));
    const indexLine = raw.split('\n').find((line) => line.startsWith('index '));
    assert.ok(indexLine !== undefined);
    assert.ok(patch.split('\n').includes(/** @type {string} */ (indexLine)));
    assert.match(patch, new RegExp(uuid));
    assert.match(patch, /\+contact: \[email\]/);
  });

  test('diff.patch остаётся кодом: ключи token/cookie справа не маскируются (#246)', (t) => {
    const { root, baseSha } = makeRepo(t);
    const code = [
      'base',
      'async function createSessionToken(): Promise<void> {',
      '  const token = request.cookies[STAFF_SESSION_COOKIE_NAME];',
      '  // cookie: проверяется только в production',
      '  if (typeof token === "string") return;',
      '}',
      '',
    ].join('\n');
    writeFileSync(join(root, 'tracked.txt'), code);
    const dir = makeCycleDir(root, { baseSha });

    assert.equal(runCli(root, ['packet', '--dir', dir]).status, 0);

    const patch = evidence(dir, 'diff.patch');
    // Код и проза после ключей сохранены байт-в-байт — цена ошибки #240: патч был невалиден.
    assert.match(patch, /\+async function createSessionToken\(\): Promise<void> \{/);
    assert.match(patch, /\+ {2}const token = request\.cookies\[STAFF_SESSION_COOKIE_NAME\];/);
    assert.match(patch, /\+ {2}\/\/ cookie: проверяется только в production/);
    assert.match(patch, /\+ {2}if \(typeof token === "string"\) return;/);
    // Патч — валидный патч: обратное применение к рабочему дереву проходит проверку.
    gitRun(root, ['apply', '--check', '--reverse', join(dir, 'evidence', 'diff.patch')]);
  });

  test('два прогона packet дают одинаковые файлы', (t) => {
    const { root, baseSha } = makeRepo(t);
    writeFileSync(join(root, 'tracked.txt'), 'base\nchanged\n');
    const dir = makeCycleDir(root, {
      baseSha,
      gates: gatesDoc(baseSha, [gate('lint', 'fail', { log: 'gates/lint.1.log' })]),
      logs: { 'gates/lint.1.log': gateLog(3) },
      qaWeb: `${JSON.stringify({ status: 'not_run', reason: 'MCP недоступен', steps: [] })}\n`,
    });

    assert.equal(runCli(root, ['packet', '--dir', dir]).status, 0);
    const snapshot = () => ({
      patch: evidence(dir, 'diff.patch'),
      gates: evidence(dir, 'gates.json'),
      qa: evidence(dir, 'qa-web.json'),
      log: evidence(dir, join('gates', 'lint.1.log')),
    });
    const first = snapshot();

    assert.equal(runCli(root, ['packet', '--dir', dir]).status, 0);
    assert.deepEqual(snapshot(), first);
  });

  test('без state.json, gates.<n>.json или criteria.md — код 2, файлов нет', (t) => {
    const { root, baseSha } = makeRepo(t);
    writeFileSync(join(root, 'tracked.txt'), 'base\nchanged\n');

    const withoutState = makeCycleDir(root, { baseSha, state: null, name: 'no-state' });
    const noState = runCli(root, ['packet', '--dir', withoutState]);
    assert.equal(noState.status, 2);
    assert.match(noState.stderr, /state\.json/);
    assert.equal(existsSync(join(withoutState, 'evidence', 'diff.patch')), false);

    const withoutGates = makeCycleDir(root, { baseSha, gates: null, name: 'no-gates' });
    const noGates = runCli(root, ['packet', '--dir', withoutGates]);
    assert.equal(noGates.status, 2);
    assert.match(noGates.stderr, /gates\.1\.json/);
    assert.equal(existsSync(join(withoutGates, 'evidence', 'diff.patch')), false);

    const withoutCriteria = makeCycleDir(root, { baseSha, criteria: null, name: 'no-criteria' });
    const noCriteria = runCli(root, ['packet', '--dir', withoutCriteria]);
    assert.equal(noCriteria.status, 2);
    assert.match(noCriteria.stderr, /criteria/);
    assert.equal(existsSync(join(withoutCriteria, 'evidence', 'diff.patch')), false);
  });

  test('битый qa-web.json — код 2, пакет не перезаписывается', (t) => {
    const { root, baseSha } = makeRepo(t);
    writeFileSync(join(root, 'tracked.txt'), 'base\nchanged\n');
    const dir = makeCycleDir(root, { baseSha, qaWeb: '{"status":' });

    const result = runCli(root, ['packet', '--dir', dir]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /qa-web\.json/);
    assert.equal(existsSync(join(dir, 'evidence', 'diff.patch')), false);
  });

  test('qa-web.json, нарушающий схему, — тоже код 2', (t) => {
    const { root, baseSha } = makeRepo(t);
    writeFileSync(join(root, 'tracked.txt'), 'base\nchanged\n');
    const dir = makeCycleDir(root, { baseSha, qaWeb: '{"status":"done"}\n' });

    const result = runCli(root, ['packet', '--dir', dir]);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /схема нарушена/);
    assert.equal(existsSync(join(dir, 'evidence', 'diff.patch')), false);
  });
});

describe('рендеринг артефактов', () => {
  test('renderIssue сохраняет тело дословно и завершает файл переводом строки', () => {
    assert.equal(renderIssue('Заголовок', 'тело\n'), '# Заголовок\n\nтело\n');
    assert.equal(renderIssue('Заголовок', 'тело'), '# Заголовок\n\nтело\n');
    assert.equal(renderIssue('Заголовок', ''), '# Заголовок\n\n');
  });

  test('renderCriteria: строка-источник и по строке на критерий', () => {
    assert.equal(
      renderCriteria({
        section: 'Готово, когда',
        template: 'task',
        criteria: [{ id: 'C1', text: 'пайплайн зелёный' }],
      }),
      [
        '# Критерии приёмки',
        '',
        'Источник: секция «Готово, когда» (шаблон task).',
        '',
        '- C1: пайплайн зелёный',
        '',
      ].join('\n'),
    );
  });
});
