# Сборка, GHCR и деплой на VPS

Цепочка: локальная проверка → CI на pull request → образы в GHCR → локальная проверка образов →
деплой на VPS по SSH через `docker compose`.

```
.github/workflows/ci.yml       проверки + сборка образов без публикации (PR, main)
.github/workflows/release.yml  образы в GHCR + деплой (main, теги v*.*.*)
docker-compose.prod.yml        рантайм на VPS и локальная проверка образов
apps/api/Dockerfile            сборка API → pnpm deploy (только prod-зависимости)
apps/web/Dockerfile            Next.js standalone
```

## 1. Локально

```bash
pnpm install
pnpm --filter @hair-lab/contracts build
pnpm typecheck && pnpm lint && pnpm check:arch && pnpm test
docker build -f apps/api/Dockerfile -t hair-lab-api:local .
docker build -f apps/web/Dockerfile -t hair-lab-web:local \
  --build-arg NEXT_PUBLIC_SITE_NAME="Стриж Lab" --build-arg NEXT_PUBLIC_SITE_CITY="Москва"
docker run --rm -p 3201:3001 hair-lab-api:local   # curl localhost:3201/health
```

## 2. CI

`ci.yml` на каждый PR: `contracts build` → `typecheck` → `lint` → `check:arch` → `test` →
`format:check`, затем сборка обоих Docker-образов (без push). Это ловит ошибки Dockerfile до main.

## 3. Образы в GHCR

`release.yml` на push в `main` публикует:

```
ghcr.io/<owner>/hair-lab-api:<sha>, :latest
ghcr.io/<owner>/hair-lab-web:<sha>, :latest
```

На тег `v*.*.*` добавляется тег версии. Слои кэшируются через `type=gha`.

## 4. Проверка образов «как из GitHub»

```bash
docker login ghcr.io -u <github-user> -p <PAT с правом read:packages>
export GHCR_IMAGE_API=ghcr.io/<owner>/hair-lab-api
export GHCR_IMAGE_WEB=ghcr.io/<owner>/hair-lab-web
export IMAGE_TAG=$(git rev-parse HEAD)
export POSTGRES_USER=hair_lab POSTGRES_PASSWORD=change_me
export CORS_ORIGINS=http://localhost:3000
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

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
- Миграции БД в пайплайне (`prisma migrate deploy` перед `up -d`) — появятся вместе со схемой.
- Откат: `IMAGE_TAG=<предыдущий sha> docker compose up -d`; процедура будет описана после первого релиза.
