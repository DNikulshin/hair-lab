# Окружение и запуск

## Требования

| Что        | Версия                  | Откуда                                     |
| ---------- | ----------------------- | ------------------------------------------ |
| Node.js    | 22.x (см. `.nvmrc`)     | `engines` в корневом `package.json`        |
| pnpm       | 9.x                     | `packageManager` в корневом `package.json` |
| PostgreSQL | 16+ (локально — Docker) | `docker-compose.yml`                       |
| Docker     | любой с compose         | локальная БД                               |

## Первый запуск

```bash
cp .env.example .env
pnpm install
pnpm --filter @hair-lab/contracts build   # контракты собираются один раз (и после правок)
pnpm dev
```

- web: http://localhost:3000
- api: http://localhost:3001, проверка — `curl localhost:3001/health`

## Переменные окружения

Все переменные описаны в `.env.example`. Валидируются Zod при старте API
(`apps/api/src/shared/config/env.ts`): при невалидном значении сервис не стартует.

| Переменная             | Где | Назначение                             |
| ---------------------- | --- | -------------------------------------- |
| `API_HOST`, `API_PORT` | api | адрес прослушивания                    |
| `LOG_LEVEL`            | api | уровень pino                           |
| `SALON_TIMEZONE`       | api | часовой пояс салона (в БД время в UTC) |
| `CORS_ORIGINS`         | api | разрешённые источники через запятую    |
| `DATABASE_URL`         | api | подключение к PostgreSQL               |
| `NEXT_PUBLIC_API_URL`  | web | адрес API для браузера                 |

Секреты в репозиторий не попадают: `.env*` в `.gitignore`, кроме `.env.example`.

## Локальная БД

```bash
docker compose up -d db
```

Порт и учётные данные — в `docker-compose.yml`, переопределяются переменными окружения
(`POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`).

## Проверки

Порядок: `contracts build` → `typecheck` → `lint` + `check:arch` → тесты.

```bash
pnpm --filter @hair-lab/contracts build
pnpm typecheck
pnpm lint
pnpm check:arch
pnpm test
pnpm test:int        # нужны PostgreSQL и заполненный .env
pnpm format:check    # проверка форматирования
```

`pnpm check:arch` — отдельный скрипт (`scripts/check-arch.mjs`), а не правило линтера:
он проверяет направление импортов между слоями и пакетами. Нарушение трактуется как BLOCKER.
