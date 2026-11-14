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

## Staging на этой машине

Не прод-контур: отдельный стек на том же хосте. Публичный адрес —
`https://hair-lab.dnikulshin.ru:8443` (наружу проброшен только 8443 → локальный 443; 80 не
слушается и не проброшен). Конфиг nginx: `deploy/nginx/hair-lab.staging.dnikulshin.ru.conf`
(wildcard-сертификат, `X-Robots-Tag: noindex`); установка — по разделу 6.

- каталог `/opt/hair-lab-staging`: `docker-compose.prod.yml` + свой `.env` (не в git);
- порты `127.0.0.1:3010` (web) и `127.0.0.1:3011` (api) — через `API_PORT`/`WEB_PORT`; 3000/3001
  остаются для `pnpm dev`;
- `APP_URL` и `CORS_ORIGINS` — `https://hair-lab.dnikulshin.ru:8443` (порт обязателен);
- `PAYMENTS_MODE=off` до появления тестовых ключей ЮKassa; адрес уведомлений в кабинете:
  `https://hair-lab.dnikulshin.ru:8443/api/payments/webhooks/yookassa`
  (`PAYMENTS_MODE=test` — когда ключи лежат в `.env` на хосте).

Файл `/opt/hair-lab-staging/.env` (не в git). Образы локальные, поэтому `GHCR_IMAGE_*` —
локальные имена, а `IMAGE_TAG=local`; секретов нет, кроме пароля БД:

```bash
GHCR_IMAGE_API=hair-lab-api
GHCR_IMAGE_WEB=hair-lab-web
GHCR_IMAGE_MIGRATIONS=hair-lab-api-migrations
IMAGE_TAG=local
POSTGRES_USER=hair_lab
POSTGRES_PASSWORD=<openssl rand -hex 24>
API_PORT=3011
WEB_PORT=3010
APP_URL=https://hair-lab.dnikulshin.ru:8443
CORS_ORIGINS=https://hair-lab.dnikulshin.ru:8443
PAYMENTS_MODE=off
SMTP_HOST=
SALON_TIMEZONE=Europe/Moscow
LOG_LEVEL=info
```

Образы собираются локально, тег `local`. Порт вшивается в `NEXT_PUBLIC_*` на сборке web:

```bash
docker build -f apps/api/Dockerfile -t hair-lab-api:local .
docker build -f apps/api/Dockerfile --target migrations -t hair-lab-api-migrations:local .
docker build -f apps/web/Dockerfile -t hair-lab-web:local \
  --build-arg NEXT_PUBLIC_SITE_NAME="Стриж Lab" \
  --build-arg NEXT_PUBLIC_SITE_URL="https://hair-lab.dnikulshin.ru:8443" \
  --build-arg NEXT_PUBLIC_API_URL="https://hair-lab.dnikulshin.ru:8443/api" .
```

`docker compose pull` в этом разделе не нужен и только помешал бы: локальные образы
`hair-lab-*:local` он попытался бы тянуть из Docker Hub. Образ `postgres:17-alpine` (сервис `db`)
compose подтянет сам при `up`. `pull` нужен только в разделе 5 — там образы приходят из GHCR.
Порядок запуска — миграции, затем контейнеры:

```bash
cd /opt/hair-lab-staging
docker compose -f docker-compose.prod.yml run --rm -T migrations
docker compose -f docker-compose.prod.yml up -d --remove-orphans
curl -sS https://hair-lab.dnikulshin.ru:8443/api/health   # {"status":"ok",...}
```

## 6. nginx и TLS

nginx на хосте — единственная точка входа, контейнеры опубликованы только на loopback.
Шаблон: `deploy/nginx/hair-lab.conf.example` (плейсхолдеры домена и сертификатов), для этой
машины — `deploy/nginx/hair-lab.staging.dnikulshin.ru.conf` (копируется без правок).

**Сертификат.** Let's Encrypt: либо wildcard `*.dnikulshin.ru` (на этом хосте —
`/etc/ssl/dnikulshin/fullchain.pem` и `/etc/ssl/dnikulshin/key.pem`, отдельное имя поддомена уже
покрыто), либо обычный на конкретное имя (`/etc/letsencrypt/live/<домен>/fullchain.pem` и
`privkey.pem`, выпуск — `certbot`). Пути в конфиге должны указывать на реальные файлы. На этой
машине используется только wildcard из `/etc/ssl/dnikulshin/`: `certbot` не установлен,
`/etc/letsencrypt` отсутствует, поэтому пути `/etc/letsencrypt/...` из шаблона сюда не годятся.

**Установка.**

Staging на этой машине — готовый конфиг `deploy/nginx/hair-lab.staging.dnikulshin.ru.conf`,
правок не требует (домен, wildcard-сертификат и порты 3010/3011 уже заданы):

```bash
sudo cp deploy/nginx/hair-lab.staging.dnikulshin.ru.conf \
        /etc/nginx/sites-available/hair-lab-staging
sudo ln -sf /etc/nginx/sites-available/hair-lab-staging /etc/nginx/sites-enabled/hair-lab-staging
sudo nginx -t && sudo systemctl reload nginx
```

Прод или другой хост — шаблон с плейсхолдерами: заменить домен и пути к сертификатам
(`/etc/letsencrypt/...` в примере — образец; для этого варианта сертификат выпускает `certbot`
или он уже есть), затем включить и проверить:

```bash
sudo cp deploy/nginx/hair-lab.conf.example /etc/nginx/sites-available/hair-lab
sudoedit /etc/nginx/sites-available/hair-lab   # server_name + ssl_certificate / ssl_certificate_key
sudo ln -sf /etc/nginx/sites-available/hair-lab /etc/nginx/sites-enabled/hair-lab
sudo nginx -t && sudo systemctl reload nginx
```

**Проверка.** С хоста — с подменой резолва, снаружи — по публичному адресу:

```bash
curl -sSI --resolve hair-lab.dnikulshin.ru:443:127.0.0.1 https://hair-lab.dnikulshin.ru/ | head
curl -sS  --resolve hair-lab.dnikulshin.ru:443:127.0.0.1 https://hair-lab.dnikulshin.ru/api/health
curl -sS https://hair-lab.dnikulshin.ru:8443/api/health   # снаружи, staging
```

Ожидаемо: 200 на `/`, `{"status":"ok",...}` на `/api/health`, заголовки безопасности в ответе,
статика из `/_next/static/` — с `Cache-Control: public, max-age=31536000, immutable`.
`http://127.0.0.1:3001` (api) снаружи недоступен.

**`X-Forwarded-For` перезаписывается, а не дописывается.** api работает с `trustProxy: true`
и берёт `request.ip` из левого значения заголовка, а по этому адресу проверяется allowlist
вебхука ЮKassa. С `$proxy_add_x_forwarded_for` клиент подделывает адрес одним заголовком и
обходит allowlist — поэтому в конфиге `proxy_set_header X-Forwarded-For $remote_addr` и в `/api/`,
и в `/` (ADR-0005), а сам api не должен быть доступен в обход прокси.

**ЮKassa и порты.** Адрес уведомлений и `return_url` у провайдера — только HTTPS на 443 или 8443.
Если 443 наружу не проброшен, публикуется 8443 → локальный 443: это штатный для ЮKassa вариант,
порт при этом входит в `APP_URL`, `CORS_ORIGINS`, `NEXT_PUBLIC_*` и в адрес вебхука.

## Что ещё не сделано

- Обновление wildcard-сертификата `*.dnikulshin.ru` на этом хосте не автоматизировано: `certbot`
  не установлен, `/etc/letsencrypt` отсутствует. Где и как сертификат выпускался
  (DNS-01) — открытый вопрос к владельцу; срок действия текущего — до 2027-01-30.
- Откат: `IMAGE_TAG=<предыдущий sha> docker compose up -d`; процедура будет описана после первого релиза.
