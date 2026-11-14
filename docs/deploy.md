# Сборка, GHCR и деплой на VPS

Цепочка: локальная проверка → CI на pull request → образы в GHCR → локальная проверка образов →
деплой на VPS по SSH через `docker compose`.

```
.github/workflows/ci.yml       проверки + сборка образов без публикации (PR, main)
.github/workflows/release.yml  образы в GHCR + деплой (main, теги v*.*.*)
docker-compose.prod.yml        рантайм на VPS и локальная проверка образов
apps/api/Dockerfile            сборка API → pnpm deploy (только prod-зависимости);
                               стадия `migrations` — образ для `prisma migrate deploy`
apps/web/Dockerfile            Next.js standalone
```

## 1. Локально

```bash
pnpm install
pnpm --filter @hair-lab/contracts build
pnpm typecheck && pnpm lint && pnpm check:arch && pnpm test
docker build -f apps/api/Dockerfile -t hair-lab-api:local .
docker build -f apps/api/Dockerfile --target migrations -t hair-lab-api-migrations:local .
docker build -f apps/web/Dockerfile -t hair-lab-web:local \
  --build-arg NEXT_PUBLIC_SITE_NAME="Стриж Lab" --build-arg NEXT_PUBLIC_SITE_CITY="Москва"
docker run --rm -p 3201:3001 hair-lab-api:local   # curl localhost:3201/health
```

## 2. CI

`ci.yml` на каждый PR: `contracts build` → `typecheck` → `lint` → `check:arch` → `test` →
`format:check`, затем сборка обоих Docker-образов (без push), а для `api` — ещё и стадии
`migrations` того же Dockerfile. Это ловит ошибки Dockerfile до main.

## 3. Образы в GHCR

`release.yml` на push в `main` публикует:

```
ghcr.io/<owner>/hair-lab-api:<sha>, :latest
ghcr.io/<owner>/hair-lab-api-migrations:<sha>, :latest
ghcr.io/<owner>/hair-lab-web:<sha>, :latest
```

На тег `v*.*.*` добавляется тег версии. Слои кэшируются через `type=gha`.

Образ миграций — отдельная стадия `migrations` того же `apps/api/Dockerfile` и тот же набор
тегов, что у api. Причина: в рантайм-образе api нет ни prisma CLI (devDependency), ни `prisma/`
с миграциями. Так версия схемы не может разъехаться с версией кода, а образ миграций
собирается и публикуется только вместе с api.

Сборка запускается только для изменённых компонентов (`scripts/changed-components.mjs`):
правка `apps/web/**` пересобирает только web, изменения в `packages/contracts/**`, `tooling/**`
или lockfile — оба. Изменения только в `docs/`, `.pi/`, `.github/`, `scripts/` и корневых `*.md`
не собирают образы вообще; тег `v*.*.*` всегда собирает оба. Подробности — в комментариях
к job'ам `changes`/`images` в workflow.

Dockerfile разделены на стадии `base → deps → build → runner`: слой `pnpm install` зависит только
от манифестов и lockfile, а исходники каждого компонента копируются отдельно. Поэтому правка
`apps/api/**` не инвалидирует кэш web и не требует переустановки зависимостей. При добавлении
нового воркспейс-пакета его `package.json` нужно дописать в стадию `deps` обоих Dockerfile.

**Ретенция.** `ghcr-cleanup.yml` раз в неделю (понедельник, 04:00 UTC) удаляет старые версии
пакетов: оставляет последние 10, никогда не трогает версию с тегом `latest` и релизные `v*.*.*`.
Ручной запуск с другим числом:

```bash
gh workflow run ghcr-cleanup.yml -f min-versions-to-keep=20
```

Проверить без удаления: запустить с заведомо большим числом (`-f min-versions-to-keep=100`).

## 4. Проверка образов «как из GitHub»

```bash
docker login ghcr.io -u <github-user> -p <PAT с правом read:packages>
export GHCR_IMAGE_API=ghcr.io/<owner>/hair-lab-api
export GHCR_IMAGE_WEB=ghcr.io/<owner>/hair-lab-web
export GHCR_IMAGE_MIGRATIONS=ghcr.io/<owner>/hair-lab-api-migrations
export IMAGE_TAG=$(git rev-parse HEAD)
export POSTGRES_USER=hair_lab POSTGRES_PASSWORD=change_me
export CORS_ORIGINS=http://localhost:3000
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml run --rm -T migrations
docker compose -f docker-compose.prod.yml up -d
```

Порядок тот же, что в деплое: `pull` → миграции → `up -d`. Сервис `migrations` вынесен
в профиль `migrations`, поэтому обычные `pull`/`up -d` его не видят; при явном упоминании сервиса
профиль включается сам (то же на VPS). Образ миграций `docker compose pull` не тянет —
`run` подтягивает его из GHCR, если образа с нужным тегом нет локально.

`GHCR_IMAGE_MIGRATIONS` обязателен, когда образы берутся из GHCR (как в блоке выше). При локальной
сборке переменную можно не экспортировать: compose подставит имя `hair-lab-api-migrations`
по умолчанию. Образ для этого собирается без тега (тег по умолчанию — `latest`):

```bash
docker build -f apps/api/Dockerfile --target migrations -t hair-lab-api-migrations .
```

Если локальный образ собран с явным тегом (например `hair-lab-api-migrations:local`), передайте
этот тег через `IMAGE_TAG`.

Контейнеры опубликованы только на `127.0.0.1` (3000 web, 3001 api). Снаружи — nginx на хосте,
конфиг: `deploy/nginx/hair-lab.conf.example` (TLS, заголовки безопасности, кэш статики,
`/api/*` → api с отрезанием префикса).

## 5. Деплой на VPS

Переменные репозитория (Settings → Variables):

| Переменная                                                                                               | Назначение                                          |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `DEPLOY_ENABLED`                                                                                         | `true` включает деплой-джобу                        |
| `VPS_APP_DIR`                                                                                            | каталог на сервере, по умолчанию `/opt/hair-lab`    |
| `POSTGRES_USER`, `POSTGRES_DB`                                                                           | учётные данные БД                                   |
| `NEXT_PUBLIC_SITE_*`, `LOG_LEVEL`                                                                        | бренд и настройки (подставляются в образ и compose) |
| `APP_URL`                                                                                                | базовый адрес для ссылок в письмах                  |
| `PAYMENTS_MODE`, `YOOKASSA_SHOP_ID`, `YOOKASSA_RETURN_URL`, `YOOKASSA_VAT_CODE`, `PAYMENT_RECEIPT_EMAIL` | ЮKassa (issue #8)                                   |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`                | почта (issue #9)                                    |

Секреты:

| Секрет                                | Назначение                                        |
| ------------------------------------- | ------------------------------------------------- |
| `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` | доступ по SSH (ключ без passphrase)               |
| `POSTGRES_PASSWORD`                   | пароль БД                                         |
| `GHCR_PAT`                            | токен с `read:packages` для `docker login` на VPS |
| `YOOKASSA_SECRET_KEY`                 | секретный ключ магазина ЮKassa                    |
| `SMTP_PASSWORD`                       | пароль приложения почты                           |

Имена образов в GHCR приводятся к нижнему регистру в workflow (шаг «Нормализовать имя образа»):
Docker не принимает заглавные буквы в имени образа.

Подготовка сервера (один раз): Docker + compose plugin, пользователь с доступом к `docker`,
каталог `${VPS_APP_DIR}`, порты 80/443 для reverse proxy.

Порядок обновления (job `deploy` в `release.yml`):

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml run --rm -T migrations
docker compose -f docker-compose.prod.yml up -d --remove-orphans
```

Миграции идут до запуска новых контейнеров и из образа того же коммита, что api (`IMAGE_TAG`).
`run` сам поднимает `db`, если она не запущена, и ждёт её healthcheck (`depends_on: service_healthy`);
`-T` отключает TTY, которого в CI нет.

**Семантика падения.** Remote-скрипт деплоя работает под `set -euo pipefail`: если `prisma migrate
deploy` завершился ошибкой, шаг краснеет, `up -d` не выполняется, старые контейнеры продолжают
работать на старой схеме, новые не запускаются. Повторный запуск идемпотентен: применённое
пропускается (в логах «No pending migrations»).

**Атомарность миграции.** По умолчанию её нет: Prisma не оборачивает миграцию PostgreSQL
в транзакцию, поэтому миграция, упавшая посередине, может оставить часть операторов применённой.
Чтобы миграция была атомарной, в `migration.sql` пишут явные `BEGIN;`/`COMMIT;` вокруг DDL,
а сами операции делают идемпотентными (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DO $$ ... $$`
для ограничений и т. п.). Это требование к **новым** миграциям (правило expand/contract, AGENTS.md,
«Данные и надёжность»); старые миграции его не гарантируют, поэтому перед восстановлением нужен
аудит фактического состояния схемы (шаг 1).

**Если миграция упала:** в `_prisma_migrations` остаётся запись с `finished_at IS NULL`
и `rolled_back_at IS NULL`, и следующий деплой упрётся в неё. Порядок восстановления:

1. **Аудит.** Что не применилось и что успело примениться до падения:

   ```bash
   docker compose -f docker-compose.prod.yml exec db \
     psql -U '<POSTGRES_USER>' -d '<POSTGRES_DB>' -c \
     "SELECT migration_name, started_at, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5;"
   ```

   `<POSTGRES_USER>` / `<POSTGRES_DB>` — значения из `POSTGRES_USER`/`POSTGRES_DB` на VPS. Запись
   в `_prisma_migrations` ничего не говорит о том, что осталось в схеме: отдельно проверьте
   фактическое состояние объектов, которые трогала миграция (`\d`, `\d+ <таблица>`,
   наличие индексов и ограничений).

2. **Зафиксировать откат средствами Prisma**, а не ручным `DELETE`. Команда заменяет `CMD` стадии
   `migrations`, работает из `/repo`, `DATABASE_URL` берётся из compose:

   ```bash
   docker compose -f docker-compose.prod.yml run --rm -T migrations \
     pnpm --filter @hair-lab/api exec prisma migrate resolve --rolled-back <migration_name>
   ```

3. **Исправить миграцию новым коммитом**, сделав её идемпотентной относительно уже применённых
   операторов (включая те, что успели примениться до падения), и прогнать деплой.
4. **Ручные `DELETE`/DDL в прод-БД — только крайний случай** с разбором в отдельном issue. Правило
   AGENTS.md «никаких ручных правок продовой БД» в силе; штатный инструмент здесь —
   `migrate resolve`.

## 6. nginx и TLS

```bash
sudo cp deploy/nginx/hair-lab.conf.example /etc/nginx/sites-available/hair-lab
# заменить домен и пути сертификатов, затем
sudo ln -s /etc/nginx/sites-available/hair-lab /etc/nginx/sites-enabled/
sudo certbot --nginx -d strizhlab.ru -d www.strizhlab.ru
sudo nginx -t && sudo systemctl reload nginx
```

Проверка: сайт по https, `https://<домен>/api/health` → `{"status":"ok"}`,
`http://127.0.0.1:3001` снаружи недоступен.

## Что ещё не сделано

- Применение nginx-конфига на VPS (файл в репозитории, установка — вручную).
- Откат: `IMAGE_TAG=<предыдущий sha> docker compose up -d`; процедура будет описана после первого релиза.
