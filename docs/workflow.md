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

## Доска

Колонки = метки статуса (работают без GitHub Projects, но переносятся в него):

| Колонка     | Метка                |
| ----------- | -------------------- |
| Todo        | `status:todo`        |
| In progress | `status:in-progress` |
| Review      | `status:review`      |
| Blocked     | `status:blocked`     |

Метки `status:review` и `status:in-progress` переключает workflow `board.yml`
по событиям PR: открытие PR → `review`, черновик → `in-progress`, закрытие → метки снимаются.
Issue закрывается автоматически строкой `Closes #<номер>` в теле PR.

### Доска Projects

https://github.com/users/DNikulshin/projects/4 — одна доска на проект, колонки = поле
`Status`: Todo / In progress / Review / Blocked / Done.

- Каждая карточка — issue репозитория; состояние в колонке выводится из меток `status:*`,
  закрытый issue попадает в Done.
- Синхронизация: `./scripts/gh-project-sync.sh` (идемпотентно, можно запускать вручную).
- Автоматически: `board.yml` вызывает скрипт, если задан секрет `PROJECT_TOKEN`
  (PAT со scope `project`; `GITHUB_TOKEN` не имеет доступа к Projects v2).
- Номер проекта переопределяется переменной репозитория `PROJECT_NUMBER` (по умолчанию 4).

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

Доска GitHub Projects (колонки по `status:*`) создаётся отдельно — нужен scope `project`:

```bash
gh auth refresh -s project,read:project
gh project create --owner DNikulshin --title "hair-lab"
```

## Definition of Done

- issue закрывается автоматически из PR;
- проверки из AGENTS.md пройдены, результат указан в PR;
- новые контракты — обратно совместимые, схема БД — только миграцией expand/contract;
- персональные данные не попали в логи, тесты, фикстуры и скриншоты;
- вне скоупа замеченное — отдельным issue, а не «попутно».
