---
name: hair-lab-api-contract
description: Изменение API hair-lab по правилам контрактов — новая Zod-схема в packages/contracts, новый или изменённый эндпоинт Fastify, потребление контракта в web. Использовать, когда задача добавляет/меняет поля запросов и ответов, роут API или тип для клиента.
---

# Контракты и API (hair-lab)

Источники истины: `AGENTS.md` («Контракты», «Архитектура»), `docs/decisions.md`,
`packages/contracts/src/index.ts` и соседние `*.contract.ts`. Не дублируй схему руками — импортируй.

## Порядок изменения

`packages/contracts` → `apps/api` → `apps/web` (и будущий мобильный клиент). Слой, идущий первым,
задаёт тип; типы руками не пишутся — только `z.infer`.

## 1. contracts

- Файл — `packages/contracts/src/<домен>/<домен>.contract.ts` + тест рядом `<домен>.contract.test.ts`.
- Экспорт — через `packages/contracts/src/index.ts`; приложения импортируют только `@hair-lab/contracts`
  (без глубоких путей).
- Только чистый TypeScript и Zod: без `node:*`, DOM, React, Fastify, бизнес-логики.
- Общие примитивы — в `common/`: `isoDateTimeSchema` (ISO 8601 с зоной), `calendarDateSchema` (`YYYY-MM-DD`),
  `moneySchema` (копейки), `phoneSchema`, `idSchema`, `idempotencyKeySchema`, `paginatedSchema`,
  ошибки — `common/errors`.
- Изменения только обратно совместимые: новые **опциональные** поля, депрекация вместо удаления.
  Старые клиенты живут неделями (кэш PWA, мобильное приложение).
- Персональные данные клиента в ответах не возвращаются (`clientPhone`, `clientEmail`) — только маска
  (`clientPhoneMasked`). Инварианты, которые схемой не выражаются, документируй комментарием в контракте.

Проверка: `pnpm --filter @hair-lab/contracts build && pnpm --filter @hair-lab/contracts test`.

## 2. api

- Фича — инкапсулированный Fastify-плагин в `apps/api/src/features/<домен>/` (routes + service + схемы),
  публичный API модуля — `index.ts`. Слои: `app → features → services → shared`; `shared` не импортирует
  features, `services` — не импортирует app/features.
- Валидация — Zod-схемы из `contracts` через `fastify-type-provider-zod`; внешний ввод валидируется
  на границе.
- Ошибки — единый формат `{ error: { code, message, requestId } }` из `contracts`.
- Деньги — копейки; время в БД UTC, на границе — ISO 8601 с зоной.
- ПД в логи не попадают, телефон в логе маскируется; проверка владельца — до чтения кэша и тяжёлых данных.
- Побочные эффекты (письма, уведомления) — вне транзакции записи (outbox), сбой провайдера не ломает запись.

## 3. web

- Данные читаются в слое фичи (`apps/web/src/features/<домен>/…`), ответ валидируется схемой из `contracts`
  до использования. Ошибки не пробрасываются в 500 — возвращается дискриминированный результат
  («пусто» ≠ «API недоступен»).
- `fetch` к API — через `apiConfig` / `withBasePath()` из `apps/web/src/shared/config/api.ts`
  (Next не добавляет `basePath` к `fetch`).
- Кэш данных включаем только после валидации: `cache: 'no-store'` + `force-dynamic` — текущее осознанное
  состояние (`docs/decisions.md`), ISR возвращаем вместе с on-demand revalidation.
- Service worker не кэширует ответы API с персональными данными.

## Проверка после правок

```bash
pnpm --filter @hair-lab/contracts build
pnpm format:check
pnpm typecheck
pnpm lint && pnpm check:arch
pnpm test
```

`apps/api/test/*.int.test.ts` — только при изменении поведения API (`pnpm test:int`, нужны Postgres и `.env`).
Если дифф затрагивает `apps/web`, браузерную проверку сценария выполняет супервизор по `docs/qa-web.md`.
Невозможную проверку помечай «не проверено» с причиной.
