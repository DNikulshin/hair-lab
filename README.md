# hair-lab

Сайт и PWA салона красоты: каталог услуг, мастера, онлайн-запись, кабинет клиента.

Правила проекта, архитектура и команды — в [AGENTS.md](./AGENTS.md) (единый источник).
Окружение и решения — в [docs/](./docs).

## Что уже есть

- pnpm workspaces + Turborepo, единый тулинг (`tooling/*`)
- `packages/contracts` — Zod-схемы публичного API (каталог, слоты и записи, аккаунт, оплата),
  собираются в ESM + d.ts и общие для web и будущих клиентов
- `apps/api` — Fastify 5, слои `app → features → shared`: каталог услуг и мастеров, слоты
  и создание записи, кабинет клиента, вход по паролю и по одноразовой ссылке, оплата ЮKassa
  (холд, вебхук, свипер), почта через transactional outbox, `GET /health`, единый формат ошибок
- PostgreSQL + Prisma, схема меняется только миграциями (`apps/api/prisma/migrations`)
- `apps/web` — Next.js App Router (PWA, Tailwind v4): каталог и мастера, визард записи, кабинет,
  вход и регистрация, экран оплаты, офлайн-страница; бренд из окружения (`NEXT_PUBLIC_SITE_*`)
- проверка границ слоёв и пакетов — `pnpm check:arch`
- Docker-образы `api`/`web` (+ образ миграций), CI → GHCR → preprod/staging
  ([docs/deploy.md](./docs/deploy.md))

## Быстрый старт

```bash
cp .env.example .env          # локальное окружение (в git не попадает)
pnpm install
pnpm --filter @hair-lab/contracts build
pnpm dev                      # web :3000, api :3001
```

Подробности: [docs/environment.md](./docs/environment.md), деплой — [docs/deploy.md](./docs/deploy.md),
процесс (ветки, issues, Kanban) — [docs/workflow.md](./docs/workflow.md), интеграции —
[docs/integrations.md](./docs/integrations.md), выбор почтового провайдера —
[docs/email-providers.md](./docs/email-providers.md).

## Структура

```
apps/
  api/                    Fastify: app/ (композиция) → features/ → services/ → shared/
    src/app/              main.ts (запуск), build-server.ts (сборка сервера)
    src/features/         фичи как инкапсулированные Fastify-плагины
    src/shared/           конфиг, логи, обработка ошибок (infrastructure)
  web/                    Next.js: app/ (роутинг) → features/ → services/ → shared/
packages/
  contracts/              Zod-схемы и типы API — источник истины для всех клиентов
tooling/
  tsconfig/ eslint/ prettier/
scripts/
  check-arch.mjs          проверка границ (BLOCKER при нарушении)
docs/
  adr/                    архитектурные решения
docker-compose.yml        локальная БД
docker-compose.prod.yml   рантайм на VPS (образы из GHCR)
deploy/nginx/             конфиг reverse proxy на хосте
scripts/gh-setup.sh       метки, вехи, бэклог, правила ветки main
.pi/
  agents/                 субагенты цикла: plan, code, review
  prompts/cycle.md        команда /cycle: план → код → ревью → PR
  settings.json           модели по умолчанию и лимиты субагентов
```
