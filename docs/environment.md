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

| Переменная               | Где | Назначение                                                                                                       |
| ------------------------ | --- | ---------------------------------------------------------------------------------------------------------------- |
| `API_HOST`, `API_PORT`   | api | адрес прослушивания                                                                                              |
| `LOG_LEVEL`              | api | уровень pino                                                                                                     |
| `SALON_TIMEZONE`         | api | часовой пояс салона (в БД время в UTC)                                                                           |
| `CORS_ORIGINS`           | api | разрешённые источники через запятую                                                                              |
| `DATABASE_URL`           | api | подключение к PostgreSQL                                                                                         |
| `API_URL`                | web | адрес API для серверных запросов web → api (runtime, в бандл не встраивается; в Docker-сети — `http://api:3001`) |
| `NEXT_PUBLIC_API_URL`    | web | адрес API для браузера                                                                                           |
| `NEXT_PUBLIC_SITE_PHONE` | web | необязательный телефон салона для публичных страниц                                                              |

Секреты в репозиторий не попадают: `.env*` в `.gitignore`, кроме `.env.example`.

## Локальная БД

```bash
docker compose up -d db
```

Порт и учётные данные — в `docker-compose.yml`, переопределяются переменными окружения
(`POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`).

Если 5432 уже занят локальным PostgreSQL, поднимаем dev-БД на другом порту и правим `DATABASE_URL`:

```bash
POSTGRES_PORT=55432 docker compose up -d db
# DATABASE_URL=postgresql://hair_lab:change_me@127.0.0.1:55432/hair_lab?schema=public
```

Схема накатывается миграциями: `pnpm --filter @hair-lab/api db:migrate:dev --name <имя>` —
перед этим нужен сгенерированный клиент (`db:generate`). Интеграционные тесты (`pnpm test:int`)
идут в ту же БД, что и `DATABASE_URL`.

## Разработка через reverse proxy (code-server)

Если dev-сервер открывается не по `localhost`, а через прокси (code-server, VS Code tunnels),
Next отдаёт абсолютные пути `/_next/...`, которые прокси не обслуживает: в консоли 404,
стили не применяются. Лечится переменными в `apps/web/.env.local` (или `NEXT_*` в окружении).

**Режим `/absproxy/<port>/` — предпочтительный.** code-server передаёт префикс приложению целиком:

```bash
NEXT_BASE_PATH=/absproxy/3000
NEXT_ALLOWED_DEV_ORIGINS=code.dnikulshin.ru
```

Открывать `https://<хост>/absproxy/3000` (без хвостового `/`). Работают ассеты, навигация и HMR.

**Режим `/proxy/<port>/`.** code-server срезает префикс, поэтому префиксом помечаем только статику:

```bash
NEXT_ASSET_PREFIX=/proxy/3000
NEXT_ALLOWED_DEV_ORIGINS=code.dnikulshin.ru
```

Ограничение: ссылки Next рендерятся от корня, поэтому переходы между страницами в этом режиме
не работают. Для полноценной разработки используйте `/absproxy/`.

`NEXT_ALLOWED_DEV_ORIGINS` нужен потому, что Next блокирует кросс-доменные dev-запросы
к `/_next/*`. В проде и в Docker эти переменные не задаются.

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
