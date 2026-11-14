# Staging: `hair-lab.dnikulshin.ru:8443`

Учебный (staging) контур салона: отдельный стек на той же машине, что и разработка, со своей БД,
своими портами и своим `.env`. Публичный адрес — **`https://hair-lab.dnikulshin.ru:8443`**:
наружу проброшен порт **8443 → локальный 443** (внешний 443 не проброшен), TLS — существующий
wildcard-сертификат `*.dnikulshin.ru` (`/etc/ssl/dnikulshin/{fullchain.pem,key.pem}`).

Общий контекст развёртывания — `docs/deploy.md` (образы, GHCR, compose, миграции).

## Что где лежит

| Что            | Где                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| Каталог стека  | `/root/hair-lab-staging` (compose-файл и `.env`, права `600`)                                              |
| Compose-проект | `-p hair-lab-staging` (том `hair-lab-staging_db-data`, контейнеры `hair-lab-staging-*`)                    |
| Порты          | `127.0.0.1:3010` (web), `127.0.0.1:3011` (api); 3000/3001 — локальный `pnpm dev`                           |
| nginx          | `/etc/nginx/sites-available/hair-lab-staging` из `deploy/nginx/hair-lab.staging.dnikulshin.ru.conf`        |
| Образы         | собираются локально из `main`: `hair-lab-api:local`, `hair-lab-api-migrations:local`, `hair-lab-web:local` |
| БД             | сервис `db` (postgres:17-alpine), наружу не публикуется; миграции — сервис `migrations`                    |

Почему не `/opt`: snap-версия Docker не видит `/opt` — `docker compose` из этого каталога падает
с `compose file "/var/lib/snapd/void/…" is invalid`. Из `/root` и `/home` работает.

Почему отдельный проект: имя `hair-lab` из `name:` в compose-файле занято более ранней попыткой,
её том `hair-lab_db-data` инициализирован другим паролем (`prisma migrate deploy` падал с
`P1000: Authentication failed`). `-p hair-lab-staging` даёт свой том и свои контейнеры.

## Обновление

```bash
sudo bash -s <<'SH'
set -euo pipefail
cd /home/dev/projects/hair-lab
docker build -f apps/api/Dockerfile -t hair-lab-api:local .
docker build -f apps/api/Dockerfile --target migrations -t hair-lab-api-migrations:local .
docker build -f apps/web/Dockerfile -t hair-lab-web:local \
  --build-arg NEXT_PUBLIC_SITE_NAME="Стриж Lab" \
  --build-arg NEXT_PUBLIC_SITE_SHORT_NAME="Стриж" \
  --build-arg NEXT_PUBLIC_SITE_URL="https://hair-lab.dnikulshin.ru:8443" \
  --build-arg NEXT_PUBLIC_API_URL="https://hair-lab.dnikulshin.ru:8443/api" \
  --build-arg NEXT_PUBLIC_SITE_CITY="Москва" \
  --build-arg NEXT_PUBLIC_SITE_TIMEZONE="Europe/Moscow" .
SH

sudo bash -c 'cd /root/hair-lab-staging && docker compose -p hair-lab-staging -f docker-compose.prod.yml run --rm -T migrations && docker compose -p hair-lab-staging -f docker-compose.prod.yml up -d --remove-orphans'
```

Порт `:8443` вшивается в `NEXT_PUBLIC_*` на сборке web — при смене адреса образ web нужно пересобрать.
`NEXT_BASE_PATH` не задаём (в отличие от локального запуска за прокси code-server).

## Демо-данные

`scripts/seed-staging.sql` — идемпотентный сид (3 категории, 4 услуги, 2 мастера, расписание пн–сб
10:00–20:00, только вымышленные данные):

```bash
sudo bash -c 'cd /root/hair-lab-staging && docker compose -p hair-lab-staging -f docker-compose.prod.yml exec -T db psql -U hair_lab -d hair_lab' < scripts/seed-staging.sql
```

## Режимы и проверенное поведение (2026-11-14)

- `PAYMENTS_MODE=test` с ключами тестового магазина ЮKassa; адрес уведомлений в кабинете магазина —
  `https://hair-lab.dnikulshin.ru:8443/api/payments/webhooks/yookassa`. Проверено живьём: запись →
  холд → оплата тестовой картой → реальный вебхук ЮKassa → запись `confirmed`, письмо клиенту.
- Почта — Gmail SMTP (app password). ⚠ Для прода это не подходит: письма содержат ПДн клиента и
  уходят в Google (трансграничная передача), что расходится с решением «свой ящик на домене» —
  см. `docs/decisions.md` и `docs/integrations.md`.
- При перезапуске api неотправленные письма «вход по ссылке» становятся `failed` с `invalid_payload`
  (сырой токен живёт только в памяти процесса) — пользователь запрашивает ссылку заново.

## Проверки после обновления

```bash
curl -sS https://hair-lab.dnikulshin.ru:8443/api/health
curl -sSI https://hair-lab.dnikulshin.ru:8443/ | head -20      # 200, заголовки безопасности, noindex
curl -sS https://hair-lab.dnikulshin.ru:8443/api/services | head -c 200
```

Браузерные сценарии — `docs/qa-web.md` (каталог, запись, оплата, PWA/офлайн).

## Остановка

```bash
sudo bash -c 'cd /root/hair-lab-staging && docker compose -p hair-lab-staging -f docker-compose.prod.yml down'
```

Том с БД сохраняется; `down -v` удалит данные стенда.
