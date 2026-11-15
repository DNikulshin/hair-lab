# Разовая настройка preprod-контура

Контур нужен, чтобы прогнать **прод-путь** (образы из GHCR → `compose pull` → миграции →
`up -d` → healthcheck) до появления VPS и не изобретать его на живом проде.
Запуск — только руками: Actions → **Preprod** → _Run workflow_ (issue #139).

| Что            | Где                                                                                     |
| -------------- | --------------------------------------------------------------------------------------- |
| Стек           | `/home/deployer/hair-lab-preprod` — `docker-compose.prod.yml` + свой `.env` (не в git)` |
| Compose-проект | `-p hair-lab-preprod` (том `hair-lab-preprod_db-data`, контейнеры `hair-lab-preprod-*`) |
| Порты          | `127.0.0.1:3020` (web), `127.0.0.1:3021` (api) — staging занимает 3010/3011             |
| Образы         | **из GHCR**, тег `preprod-<sha>`; на хосте ничего не собирается                         |
| Скрипт деплоя  | `scripts/deploy-preprod.sh` из `origin/main` деплой-клона                               |
| Маркер         | `/home/deployer/hair-lab-preprod/.deployed-sha`                                         |

## 1. Каталог стека и `.env`

```bash
sudo install -d -o deployer -g deployer -m 700 /home/deployer/hair-lab-preprod
sudo -u deployer cp /home/deployer/hair-lab-staging/docker-compose.prod.yml /home/deployer/hair-lab-preprod/
```

`.env` (права `600`, владелец `deployer`) — отличия от staging выделены:

```bash
GHCR_IMAGE_API=ghcr.io/dnikulshin/hair-lab-api
GHCR_IMAGE_WEB=ghcr.io/dnikulshin/hair-lab-web
GHCR_IMAGE_MIGRATIONS=ghcr.io/dnikulshin/hair-lab-api-migrations
IMAGE_TAG=preprod-placeholder     # перекрывает скрипт деплоя: preprod-<sha>
POSTGRES_USER=hair_lab
POSTGRES_PASSWORD=<openssl rand -hex 24>
POSTGRES_DB=hair_lab
API_PORT=3021
WEB_PORT=3020
APP_URL=https://preprod.dnikulshin.ru:8443
CORS_ORIGINS=https://preprod.dnikulshin.ru:8443
PAYMENTS_MODE=off                 # ключи магазина на preprod не нужны
SMTP_HOST=                        # почта выключена
SALON_TIMEZONE=Europe/Moscow
LOG_LEVEL=info
```

Проект и порты задаются в `.env`, поэтому `docker-compose.prod.yml` копируется без правок.

## 2. Доступ к GHCR с хоста

Образы приватные по умолчанию — тогда нужен вход (PAT со scope `read:packages`):

```bash
printf '%s' "$GHCR_PAT" | sudo -u deployer docker login ghcr.io -u DNikulshin --password-stdin
```

Либо (проще и без секрета в системе) сделать пакеты `hair-lab-api`, `hair-lab-api-migrations`
и `hair-lab-web` публичными: GitHub → Packages → _Package settings_ → _Change visibility_.
Публичные пакеты не содержат секретов, только код приложения.

## 3. Проверка руками (до первого прогона Actions)

```bash
sudo -u deployer -H bash -c 'cd /home/deployer/hair-lab-preprod && docker compose -p hair-lab-preprod -f docker-compose.prod.yml config --quiet'
sudo -u deployer docker pull ghcr.io/dnikulshin/hair-lab-api:preprod-<sha>   # после первого прогона
```

## 4. Запуск и проверка

Actions → **Preprod** → _Run workflow_ (`ref`: `main` или sha). Прогон:

1. собирает три образа в CI и пушит в GHCR с тегом `preprod-<sha>`;
2. по SSH выполняет `deploy-image <sha>` — принудительная команда из `authorized_keys`
   (та же, что у staging; отдельный ключ не нужен);
3. на хосте: `compose pull` → сверка тегов с `.env` → `run --rm migrations` → `up -d` →
   healthcheck на `127.0.0.1:3021/api/health` и `127.0.0.1:3020/` → `.deployed-sha`.

Проверка снаружи (если поднят nginx, пункт 5):

```bash
curl -sS https://preprod.dnikulshin.ru:8443/api/health
curl -sSI https://preprod.dnikulshin.ru:8443/ | head -3
```

## 5. Внешний доступ (опционально)

Контур работает и без nginx: healthcheck идёт на loopback. Чтобы смотреть глазами:

1. A-запись `preprod.dnikulshin.ru` → этот хост (проект использует wildcard-сертификат
   `*.dnikulshin.ru`, отдельный выпускать не нужно);
2. конфиг из репозитория: `deploy/nginx/hair-lab.preprod.dnikulshin.ru.conf` (server_name
   `preprod.dnikulshin.ru`, апстримы 3020/3021, `X-Robots-Tag: noindex`):

   ```bash
   sudo cp deploy/nginx/hair-lab.preprod.dnikulshin.ru.conf /etc/nginx/sites-available/hair-lab-preprod
   sudo ln -sf /etc/nginx/sites-available/hair-lab-preprod /etc/nginx/sites-enabled/hair-lab-preprod
   sudo nginx -t && sudo systemctl reload nginx
   ```

## 6. Демо-данные (по желанию)

Тот же идемпотентный сид, что на staging:

```bash
sudo -u deployer bash -c 'cd /home/deployer/hair-lab-preprod && docker compose -p hair-lab-preprod -f docker-compose.prod.yml exec -T db psql -U hair_lab -d hair_lab' \
  < scripts/seed-staging.sql
```

## Откат и выключение

- **Откат**: _Run workflow_ с `ref` = sha предыдущего коммита из истории `main` — соберутся и
  выкатятся образы `preprod-<sha>` того коммита.
- **Остановить контур**: `sudo -u deployer bash -c 'cd /home/deployer/hair-lab-preprod && docker compose -p hair-lab-preprod -f docker-compose.prod.yml down'`
  (том БД сохраняется).
- **Выключить workflow**: Actions → Preprod → _Disable workflow_.
