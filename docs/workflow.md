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
- Автоматически: `board-sync.yml` по событиям `issues` (открытие, закрытие, смена меток)
  и `pull_request`, плюс раз в сутки по расписанию как страховка. Ручной прогон —
  Actions → Board sync → Run workflow.
- Разделение прав: метки `status:*` переключает `board-labels.yml` (`GITHUB_TOKEN`),
  карточки и поле `Status` двигает `board-sync.yml` — ему нужен PAT.
- Номер проекта переопределяется переменной репозитория `PROJECT_NUMBER` (по умолчанию 4).

#### Секрет `PROJECT_TOKEN`

`GITHUB_TOKEN` не имеет доступа к Projects v2, поэтому сверке нужен отдельный токен.
Если секрета нет, `board-sync.yml` падает с инструкцией — молчаливого пропуска больше нет
(issue #280: доска разошлась с репозиторием на 30 карточек, а прогоны были зелёными).

Fine-grained PAT (рекомендуется — минимальные права):

1. https://github.com/settings/personal-access-tokens/new
2. Resource owner — `DNikulshin`; Repository access → Only select repositories → `hair-lab`;
   Repository permissions → Issues: **Read-only**, Pull requests: **Read-only**
   (Metadata: Read подставится сам).
3. Account permissions → Projects: **Read and write** — это и есть доступ к Projects v2
   пользователя.
4. Expiration — не больше 90 дней; дату окончания — в календарь.
5. Положить в секрет: `gh secret set PROJECT_TOKEN --repo DNikulshin/hair-lab` (вставить токен)
   или Settings → Secrets and variables → Actions → New repository secret.
6. Проверить: Actions → Board sync → Run workflow; в логе — «без изменений <N>».

Classic PAT как альтернатива: https://github.com/settings/tokens/new?scopes=project,repo&description=hair-lab-board-sync
— scope `project` (запись в Projects) и `repo` (чтение issues).

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

## Коммиты

Формат: `<type>(<scope>): <что сделано>`, где `type` — `feat|fix|chore|refactor|test|docs|data|design`,
`scope` — `api|web|contracts|infra|db`.

```
data(db): схема услуг, мастеров и слотов
feat(api): POST /bookings с идемпотентностью
fix(web): не терять выбранный слот при ошибке сети
```

Один коммит — одно логическое изменение. Сообщения на русском, по делу, без «wip» в финале.

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
- вне скоупа замеченное — отдельным issue, а не «попутно».
