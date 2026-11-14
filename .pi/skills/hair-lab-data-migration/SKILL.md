---
name: hair-lab-data-migration
description: "Изменение схемы БД hair-lab и Prisma-миграции в apps/api/prisma — новая модель или поле, EXCLUDE/CHECK-ограничения, expand/contract, бэкфилл, интеграционные тесты БД. Использовать, когда задача трогает схему, миграции, уникальность слотов или данные в Postgres."
---

# Схема БД и миграции (hair-lab)

Источники истины: `AGENTS.md` («Данные и надёжность»), `docs/decisions.md`, `docs/environment.md`
и текущий `apps/api/prisma/schema.prisma`. Перед правкой прочитай схему целиком — соглашения уже там.

## Ветка

`data/<номер-issue>-<коротко>` от `main` (`docs/workflow.md`).

## Правка схемы

Файл — `apps/api/prisma/schema.prisma`:

- время: `DateTime @db.Timestamptz(3)` + `@map("...")`; в БД UTC, пояс салона только в конфиге `SALON_TIMEZONE`;
- id: `String @id @default(uuid()) @db.Uuid`; таблица `@@map("snake_case_plural")`, поля `@map("snake_case")`;
- деньги — `Int` в копейках (`price_kopecks`), длительность — `Int` в минутах;
- удаление не физическое: `isActive Boolean @default(true)`; история записей сохраняется
  (`onDelete: SetNull` для ссылок на клиента и категорию);
- `url` в схеме запрещён: строка подключения живёт в `apps/api/prisma.config.ts` и берётся из `DATABASE_URL`.

## Миграция

```bash
pnpm --filter @hair-lab/api db:generate
pnpm --filter @hair-lab/api db:migrate:dev --name <snake_case_имя>
```

- Локальная БД — docker compose `db` (`docs/environment.md`; dev-инстанс на `127.0.0.1:55432`).
- После генерации обязательно открой `apps/api/prisma/migrations/<ts>_<имя>/migration.sql`:
  Prisma **не** выражает `EXCLUDE`, `CHECK`, `btree_gist` — такое дописывается в тот же файл руками
  (образец — `20261112234607_init_db_schema`: `CREATE EXTENSION IF NOT EXISTS btree_gist`,
  `EXCLUDE USING gist (... tstzrange ...)`, CHECK на длительность/цены/рабочие часы).
- Применённые миграции не правятся. Ошибка в уже применённой — новая миграция.
- Накат на окружение: `pnpm --filter @hair-lab/api db:migrate:deploy`.

## expand/contract

Несовместимое изменение делится на шаги, каждый — отдельная миграция и отдельный деплой:

1. expand: добавить колонку/таблицу nullable, без изменения старых контрактов;
2. бэкфилл данных (идемпотентный, батчами, вне транзакции записи);
3. contract: `NOT NULL`/переименование/удаление — после того как все читатели обновлены.

Текущее состояние: `services.category_id` намеренно nullable, `NOT NULL` — отдельной contract-миграцией.

## Тесты

Интеграционные тесты БД — `apps/api/test/db/*.int.test.ts` на общих хелперах
`createTestDb`, `createFixture`, `captureError`, `sqlStateOf` из `./helpers`; каждая проверка —
на вымышленных данных. Затем:

```bash
pnpm --filter @hair-lab/api db:generate   # если схема менялась
pnpm test:int                            # нужны Postgres и .env
pnpm typecheck && pnpm lint && pnpm check:arch
```

Проверку, которую не удалось выполнить (нет БД), помечай «не проверено» с причиной.

## Запрещено

`prisma db push`, `prisma migrate reset`, `--force-reset`, `--accept-data-loss`, `DROP`/`TRUNCATE`
вне миграции, ручные правки продовой БД, правка применённых миграций, персональные данные
клиентов в сидах и фикстурах.
