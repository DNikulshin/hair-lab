# Процесс разработки: ветки, issues, Kanban

Модель: trunk-based с короткоживущими ветками. `main` всегда готова к деплою, изменения
попадают в неё только через pull request. Работа ведётся по issues, статусы — метками
(колонки доски).

## Роли

| Шаг                                     | Кто      |
| --------------------------------------- | -------- |
| Декомпозиция, issue, ветка, коммиты, PR | агент    |
| Правки по ревью в той же ветке          | агент    |
| Проверка и merge PR                     | владелец |
| Проверка корректности слияния по тегу   | агент    |

Правила: агент не пушит в `main` и не мержит PR. Исключение — первичный bootstrap пустого
репозитория, согласованный с владельцем явно.

Правило проверяется механизмом, а не памятью: хуки `.githooks/pre-commit` и `.githooks/pre-push`
отклоняют коммит и push в `main`/`master` (`scripts/lib/git-guard.mjs`), подсказывая команду
создания ветки. Обход — только `--no-verify` (bootstrap). См. «Pre-commit и pre-push»
в `AGENTS.md`.

## Доска

Колонки = метки статуса (работают без GitHub Projects, но переносятся в него):

| Колонка     | Метка                |
| ----------- | -------------------- |
| Todo        | `status:todo`        |
| In progress | `status:in-progress` |
| Review      | `status:review`      |
| Blocked     | `status:blocked`     |

Метки `status:review` и `status:in-progress` переключает workflow `board-labels.yml`
по событиям PR: открытие PR → `review`, черновик → `in-progress`, закрытие → метки снимаются.
Issue закрывается автоматически строкой `Closes #<номер>` в теле PR.

### Доска Projects

https://github.com/users/DNikulshin/projects/4 — одна доска на проект, колонки = поле
`Status`: Todo / In progress / Review / Blocked / Done.

- Каждая карточка — issue репозитория; состояние в колонке выводится из меток `status:*`,
  закрытый issue попадает в Done.
- Сверка: `./scripts/gh-project-sync.sh` — идемпотентна, запускается вручную в любой момент.
  `DRY_RUN=1 ./scripts/gh-project-sync.sh` печатает план и ничего не пишет в проект.
  Доска читается одним GraphQL-снимком (`gh api graphql`): id проекта, поле `Status`
  с опциями и карточки постранично по 100 — вместо трёх раздельных `gh project …`
  (issue #283: ~10 s → ~5 s на пустом прогоне).
- Автоматически: `board-sync.yml` по событиям `issues` (открытие, закрытие, смена меток)
  и `pull_request`, плюс раз в сутки по расписанию как страховку. Ручной прогон —
  Actions → Board sync → Run workflow. Метки `type:*`/`area:*`/`prio:*`/`size:*`
  на колонку не влияют и полной сверки не запускают — только `status:*`.
- Разделение прав: метки `status:*` переключает `board-labels.yml` (`GITHUB_TOKEN`),
  карточки и поле `Status` двигает `board-sync.yml` — ему нужен PAT.
- Номер проекта переопределяется переменной репозитория `PROJECT_NUMBER` (по умолчанию 4).

#### Секрет `PROJECT_TOKEN`

`GITHUB_TOKEN` не имеет доступа к Projects v2, поэтому сверке нужен отдельный токен.
Если секрета нет, `board-sync.yml` падает с инструкцией — молчаливого пропуска больше нет
(issue #280: доска разошлась с репозиторием на 30 карточек, а прогоны были зелёными).

Classic PAT (рабочий вариант): https://github.com/settings/tokens/new?scopes=project,repo&description=hair-lab-board-sync
— scope `project` (проекты и карточки) и `repo` (issues). Права аккаунта — полные только там,
где нужно; токен личный, не организации.

Fine-grained PAT для `gh project` **не подходит** (проверено 2026-11-18): `gh` проверяет
классические scopes токена и на fine-grained падает до запроса —
`your authentication token is missing required scopes [read:org read:discussion]`
(прогон 44401162112, gh 2.103.3), хотя `Account permissions` → `Projects: Read and write`
выданы. Если `gh` это починит, тем же токеном можно будет обойтись без classic-токена.

Почему в workflow `OWNER: '@me'`, а не логин: `gh project … --owner <логин>` сначала
определяет тип владельца запросом `user(login:)`, и если токен такого запроса не получает,
gh падает с `unknown owner type` (прогон 44397670721: сначала `Resource not accessible by
personal access token (user.projectV2)`, после выдачи прав — `unknown owner type`).
`@me` резолвится через `viewer` и от этого не зависит; репозиторий передаётся отдельно (`REPO`).
Локальный запуск скрипта без переменных по-прежнему берёт `DNikulshin`.

Упавший `board-sync.yml` с сообщением «Секрет PROJECT_TOKEN не задан» означает и истёкший
токен: продлить/выпустить новый и повторить `gh secret set`.

Дополнительные метки: `type:*` (feature/bug/chore/spike), `area:*` (api/web/contracts/data/infra/design),
`prio:p1..p3`, `size:s|m|l`, `needs-owner` (нужно решение, а не код).

## Ветки

```
feat/<номер-issue>-<коротко>     новая функциональность
fix/<номер-issue>-<коротко>      исправление
chore/<номер-issue>-<коротко>    инфраструктура, зависимости
data/<номер-issue>-<коротко>     схема БД и миграции
design/<номер-issue>-<коротко>   визуальный слой
```

Пример: `data/1-schema-bookings`. Ветка живёт не дольше одной задачи; после merge удаляется
автоматически (`delete_branch_on_merge`).

Локальная копия умирает вместе с ней. Squash-merge не делает коммит ветки предком `main`,
поэтому «ветка не влита» и «есть что пушить» — не признак незавершённой работы (issue #285:
сессия 19.11 продолжила работу на ветке, чей PR уже был смержен). Состояние берётся фактом:

```bash
pnpm git:hygiene              # локальные ветки со смерженными PR + статус текущей
pnpm git:hygiene --prune      # удалить такие ветки (текущая не удаляется)
gh pr list --head <ветка>     # состояние PR ветки
gh issue view <номер>         # состояние задачи
```

`pre-push` отклоняет push ветки, чей PR `MERGED` (`scripts/lib/branch-guard.mjs`), и
подсказывает команду очистки вместо тихого успеха. GitHub недоступен — только предупреждение:
проверка защищённых веток работает офлайн. Обход — `git push --no-verify`, осознанно.

## Коммиты

Формат: `<type>(<scope>): <что сделано>`, где `type` — `feat|fix|chore|refactor|test|docs|data|design`,
`scope` — `api|web|contracts|infra|db`.

```
data(db): схема услуг, мастеров и слотов
feat(api): POST /bookings с идемпотентностью
fix(web): не терять выбранный слот при ошибке сети
```

Один коммит — одно логическое изменение. Сообщения на русском, по делу, без «wip» в финале.

### Проверки workflow (`pnpm lint:workflows`)

Один гейт делает две проверки: `actionlint` (схема и выражения YAML) и `bash -n` по каждому
`run:`-блоку (shell-синтаксис, issue #146). Вторая добавлена потому, что `actionlint`
проверяет run-блоки через shellcheck, а локально его нет: бинарника нет в `PATH`, скачивание
с GitHub Releases режется сетью. Из-за этого локальный гейт был слабее CI: “хвост” старого
heredoc в `release.yml` прошёл локально и упал в CI (`SC1072`, PR #145).

Правила проверки run-блоков: YAML разбирается текстово (`scripts/lib/workflow-runs.mjs`,
зависимости `yaml` в проекте нет), `${{ … }}` заменяются на `EXPR`, шаги с чужим `shell:`
(`python`, `pwsh`) не проверяются. Ошибка печатает workflow:строку, job и шаг. Когда shellcheck
будет доступен в окружении, его можно включить дополнительно — `bash -n` остаётся самым
дешёвым локальным гейтом и не мешает CI.

## Pull request

- Заголовок = одна строка о сути; в теле — `Closes #N`, «как проверять», чек-лист из шаблона.
- Объём: одна задача. Если дифф разрастается — дробить на PR.
- Merge — squash: в `main` попадает один коммит, история линейная. Merge commit и rebase
  отключены на уровне репозитория.
- PR не мержится, пока не зелёные `checks`, `docker (api, apps/api/Dockerfile)`,
  `docker (web, apps/web/Dockerfile)`
  (правила ветки `main`, включаются `./scripts/gh-setup.sh --protect`).
- Правила действуют и для владельца: `enforce_admins: true` — прямой push в `main` через
  UI/API/CLI отклоняется, PR и зелёные checks обязательны всем. Временное снятие защиты
  — осознанное действие владельца, возврат — тем же `--protect`.

## Метки и релизы

Тег `v<major>.<minor>.<patch>` ставится на `main` после merge. `release.yml` по тегу:

1. `verify-tag` — проверяет, что коммит тега содержится в `main` (иначе «слияние некорректно»),
   и прогоняет проверки заново;
2. `images` — публикует образы в GHCR с тегом `sha`, `latest` и версией;
3. `deploy` — только на push в `main` и только при `DEPLOY_ENABLED=true`.

## Настройка (один раз)

```bash
./scripts/gh-setup.sh            # метки, вехи, бэклог
./scripts/gh-setup.sh --protect  # правила ветки main (после первого push)
```

`--protect` ставит PR как единственный путь в `main` для всех, включая владельца
(`enforce_admins: true`), требует зелёные `checks` и `docker (api|web)` в актуальном
состоянии с `main` (`strict: true`), запрещает force-push и удаление ветки. Проверка:
`gh api repos/DNikulshin/hair-lab/branches/main/protection --jq '.enforce_admins.enabled'`
→ `true`. Автотестов на это нет: настройка живёт в GitHub — проверяется выводом API.

Доска GitHub Projects (колонки по `status:*`) создаётся отдельно — нужен scope `project`:

```bash
gh auth refresh -s project,read:project
gh project create --owner DNikulshin --title "hair-lab"
```

## Definition of Done

- issue закрывается автоматически из PR;
- проверки из AGENTS.md пройдены, результат указан в PR;
- **гейты:** для задач, прошедших `/cycle`, PR не мержится, пока обязательные гейты
  в `gates.<n>.json` не зелёные: `contracts_build`, `typecheck`, `lint`, `check_arch`,
  `lint_workflows`, `test`, `test_scripts`, `check_harness`, `format_check`, `secrets_scan`,
  а также `migrations_clean` и `test_int`, если дифф затрагивает `apps/api/`.
  `migrations_clean`/`test_int` без БД — `not_run` с причиной `no_database`: это не провал,
  но и не проверка, такие пункты идут в блок «не проверено»;
- **статусы гейтов:** `skipped` — условие не выполнено (например `lint_workflows` без правки
  workflow), он не считается непроверенным и не блокирует; `not_run` без `no_database` —
  непроверенный обязательный гейт и блокер для чистого `PROCEED`;
- **независимая оценка:** в PR есть раздел «Независимая оценка» с вердиктом ревью, вердиктом
  оценщика (`evaluation.<n>.json`), таблицей критериев `C1…Cn` со статусами и ссылками на
  свидетельства, числом итераций; решение о доработке и о PR принимает `cycle-decide`, а не автор;
- при `PROCEED_WITH_UNVERIFIED` в PR есть блок «не проверено» с чекбоксами для владельца —
  снимает он, не агент;
- новые контракты — обратно совместимые, схема БД — только миграцией expand/contract;
- персональные данные не попали в логи, тесты, фикстуры, `qa-web.json` и скриншоты;
- вне скоупа замеченное — отдельным issue, а не «попутно»;
- локальная ветка после merge удалена (`pnpm git:hygiene --prune`), работа продолжается от
  обновлённого `main`.
