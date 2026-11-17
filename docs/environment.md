# Окружение и запуск

## Требования

| Что        | Версия                 | Откуда                                      |
| ---------- | ---------------------- | ------------------------------------------- |
| Node.js    | 26.x (см. `.nvmrc`)    | `engines` в корневом `package.json`         |
| pnpm       | 9.x                    | `packageManager` в корневом `package.json`  |
| PostgreSQL | 17 (локально — Docker) | `docker-compose.yml` (`postgres:17-alpine`) |
| Docker     | любой с compose        | локальная БД                                |

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

Ниже — минимум, без которого не работают витрина и запись. Полный список (включая `PAYMENTS_*`,
`SMTP_*`, `APP_URL`, `NEXT_PUBLIC_SITE_*`) — в `.env.example`, назначение интеграционных
переменных — в `docs/integrations.md`.

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

### `DATABASE_URL` и гейт `test_int` в `/cycle`

Гейт `test_int` берёт `DATABASE_URL` из **окружения процесса**, а `.env` не читает. Поэтому
перед циклом переменную нужно экспортировать, иначе гейт не увидит базу:

```bash
export DATABASE_URL='postgresql://hair_lab:change_me@127.0.0.1:55432/hair_lab?schema=public'
node scripts/cycle-gates.mjs --dir <каталог цикла>
```

Исходы гейта различаются по смыслу (docs/orchestrator-core.md §5.5):

- `pass` — база доступна, тесты прошли;
- `not_run (no_database)` — переменная задана, но база недоступна: решение будет
  `PROCEED_WITH_UNVERIFIED` с отметкой `gate:test_int not_run (no_database)` в PR;
- `fail` — переменной нет вовсе или упал сам тест. Это конфигурация, а не отсутствие базы:
  цикл увидит провал гейта, а не «не проверено».

## Разработка через reverse proxy (code-server)

Если dev-сервер открывается не по `localhost`, а через прокси (code-server, VS Code tunnels),
Next отдаёт абсолютные пути `/_next/...`, которые прокси не обслуживает: в консоли 404,
стили не применяются. Лечится переменными в `apps/web/.env.local` (или `NEXT_*` в окружении).

`NEXT_BASE_PATH` влияет и на клиентские запросы: Next добавляет `basePath` к `<Link>` и маршрутам,
но не к `fetch`, поэтому клиентские модули API используют `withBasePath()` из
`apps/web/src/shared/config/api.ts`. База встраивается в бандл на сборке через `env` в `next.config.ts`.

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

## Веб-поиск агента (локальный SearXNG)

`web_search` в pi работает без ключа и без внешних аккаунтов: запросы идут в локальный SearXNG,
поднятый контейнером `searxng/searxng:latest` на `127.0.0.1:8888` (`restart: unless-stopped`).
Конфиг инстанса — `~/searxng/settings.yml` (`use_default_settings`, JSON API включён, `limiter` и
`public_instance` выключены), поэтому наружу он не смотрит и от прокси не зависит.

Настройки инструмента — `~/.pi/agent/web-search.json`:

```json
{
  "searxngBaseUrl": "http://127.0.0.1:8888",
  "searchRouting": {
    "providers": ["searxng", "duckduckgo"],
    "fallbackOn": ["network", "transient", "quota", "invalid-response", "empty", "unsupported"],
    "timeoutMs": 25000
  }
}
```

`searchRouting` — это последовательный резерв: сначала `searxng`, и только если он вернул сетевую,
транзиентную или пустую ошибку — `duckduckgo` (бесплатный, без ключа). Провайдеры вроде `degoog`
не годятся: публичный инстанс отвечает десятки секунд и обрывает JSON.

MCP-сервер (`~/.pi/agent/mcp.json`, тот же инстанс) даёт категории, чтение URL по разделам и
диагностику движков: `SEARXNG_TIMEOUT_MS=20000`, `FETCH_TIMEOUT_MS=20000` — запас на медленные
категории и страницы. Маршрутизация ресерча — `docs/research.md`.

### Отключённые движки

Инстанс отсекает медленные и заблокированные движки: каждый отваливается по таймауту или
`access denied` и держит весь запрос до общего дедлайна. Список — в `~/searxng/settings.yml`
(`engines: [{name, disabled: true}]`): `ahmia`, `torch` (нет tor-прокси), `mankier`, `pubmed`,
`wikidata` (timeout в каждом прогоне), `google scholar`, `semantic scholar` (access denied).

Замеры `curl` по категориям (2026-11-17, до/после отключения):

| Категория | До                                           | После     | Результатов |
| --------- | -------------------------------------------- | --------- | ----------- |
| `it`      | ~10 с (упиралась в клиентский таймаут 10 с)  | 0.5–0.9 с | 20          |
| `science` | 3–5 с, предупреждения о `pubmed`/`europepmc` | 0.5–0.9 с | 30          |
| `general` | 0.9–3 с                                      | 0.3–1.1 с | 20–38       |

`news` работает через `bing news` и годится только для настоящих новостей, не для техники.
На фильтр `engines` в MCP-инструменте не полагаться: категория фильтрует надёжно, конкретный движок —
нет, а запрос с явным `engines` может зависнуть до клиентского таймаута.

Проверка и перезапуск:

```bash
curl -s 'http://127.0.0.1:8888/search?q=test&format=json' | head -c 200   # должен отдать JSON
docker ps --filter name=searxng                                            # контейнер жив?
docker restart searxng                                                     # если нет
```

Правка `settings.yml` требует перезапуска контейнера: файл смонтирован внутрь, но читается
на старте.

Docker здесь из snap (`/snap/bin/docker`). 2026-11-17 из pi перезапуск прошёл, но
при ошибке `snap-confine is packaged without necessary permissions` (юнит systemd с
`NoNewPrivileges=true`) перезапускать в своём терминале.

После правки `web-search.json` нужен `/reload` в pi: конфиг читается один раз на процесс.

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
