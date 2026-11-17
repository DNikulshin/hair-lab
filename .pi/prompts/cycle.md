---
description: Цикл plan → code → gates → review → evaluate → decide по протоколу оркестратора
argument-hint: '<номер issue и что сделать>'
---

Задача: ${@:-<номер issue и что сделать>}

Ты супервизор цикла. Читаешь `AGENTS.md` (команды, границы слоёв, ПДн, git-процесс) и
`docs/orchestrator.md` (политика). Протокол — Приложение B `docs/orchestrator-core.md`;
этот файл — его рабочая форма. Состояние, переходы и решения ведут скрипты, а не ты:
**запрещено** править `state.json` руками, пропускать этапы, менять `action` из
`decision.<n>.json`, обходить `cycle-state` и мержить PR.

Стадии автомата: `INIT`, `PLAN`, `CODE`, `GATES`, `QA_WEB`, `REVIEW`, `EVALUATE`, `DECIDE`,
`REWORK`, `ACQUIRE_EVIDENCE`, `PR`, `DONE`, `ESCALATED`. Переходы разрешает только
`cycle-state advance`; недопустимый переход — код 3, это стоп, а не повод обойти.

Каталог: `.pi/artifacts/<YYYY-MM-DD>-<номер>-<slug>/` (в `.gitignore`). `--dir` у скриптов
по умолчанию — единственный активный цикл; ниже он подразумевается.

## INIT

1. `node scripts/cycle-state.mjs lock` — одна блокировка на дерево.
2. `gh issue view <N> --json title,body,labels > <dir>/issue.json`.
3. `node scripts/cycle-state.mjs init --issue <N> --slug <slug> --branch <ветка>`, ветка от
   `main`: `feat|fix|chore|data|design/<номер>-<коротко>`.
4. `node scripts/cycle-evidence.mjs criteria --dir <dir> --issue-json <dir>/issue.json`.
   Код ≠ 0 → `cycle-state escalate --reason criteria_missing`, комментарий в issue
   (`status:blocked`, `needs-owner`), стоп.

## PLAN

`cycle-state advance --to PLAN` → субагент `plan` (read-only) → `plan.<n>.md` →
`cycle-state finish --stage PLAN --status done`. План просит выбирать вариант →
`escalate --reason plan_ambiguous`, стоп.

## CODE

`advance --to CODE` → субагент `code` с планом, номером issue и требованиями `AGENTS.md`.
Он правит файлы и прогоняет проверки; ты пишешь `code-report.<n>.md` (файлы, что изменено,
вывод проверок, «не проверено» с причиной) и вызываешь `finish --stage CODE --status done`.
Правки файлов делает только `code`; ты коммитишь, пушишь и ведёшь артефакты.

## Как устроены переходы (читай до GATES)

- `advance --to X` открывает этап `X`; пока этап открыт (`stage_status: running`), следующий
  `advance` даёт код 3. Поэтому схема любого этапа: `advance` → работа → `finish`.
- `apply-decision` **сам** переводит автомат в целевой этап решения (`REWORK`, `ACQUIRE_EVIDENCE`,
  `PR`, этап `RETRY_STAGE`). Повторный `advance` в тот же этап после `apply-decision` — ошибка:
  целевой этап уже открыт, его надо отработать и закрыть `finish`.
- У `DECIDE` своего `finish` нет: его закрывает `apply-decision`. У `INIT` — тоже нет.
- Терминальные `DONE`/`ESCALATED` вперёд не переходят.

## GATES

`advance --to GATES` → `node scripts/cycle-gates.mjs --dir <dir>` →
`cycle-state finish --stage GATES --status done`. Код 1 — упал гейт, это **не сбой цикла**:
`gates.<n>.json` написан, этап отработан, идём до DECIDE. Код 2 — ошибка инструмента:
разбирайся, при необходимости `finish --status error` и `escalate`.

## QA_WEB

Только если дифф затрагивает `apps/web`: `advance --to QA_WEB` → сценарий `docs/qa-web.md`
в браузере (MCP `playwright`/`chrome-devtools`, production-сборка на 3003) → сырые факты в
`<dir>/qa-web.json` с `id` шагов `s1`, `s2`, … по формату из `docs/qa-web.md` → `finish`.
MCP недоступен — `{"status": "not_run", "reason": "<причина>", "steps": []}` (поле `steps`
обязательно при любом `status`). ПДн в файл не пишем.

## REVIEW и EVALUATE

1. `node scripts/cycle-evidence.mjs packet --dir <dir>` — сам добавляет untracked-файлы
   (`git add --intent-to-add`) и собирает `evidence/`: `issue.md`, `criteria.md`,
   `diff.patch`, `gates.json`, логи упавших гейтов, `qa-web.json`. Код 4 (`diff_too_large`) →
   `escalate --reason diff_too_large`.
2. `advance --to REVIEW` → субагент `review`: ему план, `git diff <base_sha>` и путь к
   `evidence/`; ответ → `review.<n>.md` (последний блок ```json обязателен) →
   `finish --stage REVIEW --status done`.
3. `advance --to EVALUATE` → субагент `evaluate`: ему **только** `evidence/` (план, отчёт
   кода и ревью не передаём — оценка слепая, R2); ответ → `evaluation.<n>.md` →
   `finish --stage EVALUATE --status done`.

`review.<n>.json` и `evaluation.<n>.json` руками не пишет никто: их извлекает `cycle-decide`.

## Расход токенов

После каждого этапа, где работал субагент (`PLAN`, `CODE`, `REVIEW`, `EVALUATE`), собери расход:

`node scripts/cycle-usage.mjs --dir <dir> --stage <plan|code|review|evaluate> --transcript <id>_<agent>_transcript.jsonl`

Транскрипт лежит в `~/.pi/agent/sessions/<проект>/subagent-artifacts/`. Прогонов бывает
несколько (итерации `CODE`, повтор `REVIEW`) — вызывай для каждого, суммы складываются.
Без этого `metrics.json` пишет `tokens` и `cost_rub` как `null`: «не измеряли», а не «ноль».

## DECIDE

`advance --to DECIDE` → `node scripts/cycle-decide.mjs --dir <dir>` →
`node scripts/cycle-state.mjs apply-decision` (он же переводит автомат дальше).
Дальше — строго по `action`, без своих решений:

- `RETRY_STAGE` — этап `retry_stage` уже открыт: повтори его работу, `finish`, затем продолжай
  по таблице переходов §5.3;
- `ACQUIRE_EVIDENCE` — этап-учёт, сам свидетельств не добывает: закрой его
  (`finish --stage ACQUIRE_EVIDENCE --status done`), затем пройди по **всем** пунктам
  `acquire[]` через их обычные этапы, каждый — один раз:
  есть `gate:<id>` → `advance --to GATES` (при необходимости `cycle-gates --dir <dir> --only <id>`)
  → `finish --stage GATES`; есть `qa-web` → `advance --to QA_WEB` → сценарий `docs/qa-web.md`
  один раз → `finish --stage QA_WEB`. Если в `acquire[]` есть и то, и другое — сначала GATES,
  потом QA_WEB (`GATES → QA_WEB` разрешён). Дальше снова `cycle-evidence packet` → REVIEW →
  EVALUATE → DECIDE;
- `REWORK` — этап `REWORK` открыт: запиши `rework-brief.<n>.md` из `rework_items` дословно,
  `finish --stage REWORK --status done`, затем `advance --to CODE` (итерация увеличивается на
  этом ребре). Лимит — `max_iterations` из `state.json` (по умолчанию 2); сверх лимита только
  `advance --to CODE --owner-approved` с явного разрешения владельца;
- `PROCEED` / `PROCEED_WITH_UNVERIFIED` — этап `PR` уже открыт: сначала `followups.md`
  (замечания вне скоупа — до сборки тела, иначе раздел «Вне скоупа» останется пустым),
  потом коммиты (`<type>(<scope>): <что>`), `git push -u origin <ветка>`, тело —
  `node scripts/cycle-pr-body.mjs` (при `PROCEED_WITH_UNVERIFIED` там будет блок «не проверено»),
  `gh pr create --body-file …`, метка `status:review`, `finish --stage PR --status done`.
  **PR не мержить**: мерж делает владелец;
- `ESCALATE` — автомат уже в `ESCALATED`: комментарий в issue, `status:blocked`, `needs-owner`.
  Draft PR — только если `escalation.draft_pr_allowed`: тело собирает
  `cycle-pr-body --dir <dir> --draft-escalation`.

## DONE и ESCALATED

После мержа владельцем и `git pull` (цикл видит свой PR смерженным): `advance --to DONE` →
`node scripts/cycle-metrics.mjs --dir <dir>` → `node scripts/cycle-state.mjs unlock`.
`ESCALATED` — цикл закрыт: метрики пишутся так же, `unlock` обязателен.

## Правила

- проверки — строго в порядке `contracts build` → `typecheck` → `lint` + `check:arch` +
  `check:harness` → тесты; в PR только фактические результаты;
- не расширяй скоуп, не трогай `.env*`, `node_modules`, lockfile без причины; контракты только
  обратно совместимые, БД — только миграциями expand/contract;
- замечания вне скоупа — в `followups.md`, итерацию они не запускают;
- «не проверено» всегда с причиной; «проверено» без запуска не пишем.

Итог в ответе: ссылка на PR, ветка, изменённые файлы, итераций из `state.json`, результаты
гейтов и оценки, follow-ups.
