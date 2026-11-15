# Preprod: ручной прогон прод-пути

Контур между staging и продом. Задача — проверить **механику прода** (образы из GHCR, `compose pull`,
миграции из образа того же коммита, `up -d`, healthcheck) на живом хосте, не трогая staging
и не дожидаясь VPS. Запускается **только руками**: Actions → **Preprod** → _Run workflow_.

Настройка контура — `deploy/preprod/install.md`.

## Чем отличается от staging (`docs/staging.md`)

|                  | staging                               | preprod                                          |
| ---------------- | ------------------------------------- | ------------------------------------------------ |
| Триггер          | merge в `main` (авто)                 | `workflow_dispatch` (ручной)                     |
| Образы           | собираются на хосте под адрес `:8443` | собираются в CI, стек **пуллит** их из GHCR      |
| Стек             | `hair-lab-staging`, 3010/3011         | `hair-lab-preprod`, 3020/3021, свой том БД       |
| Тег              | `local`                               | `preprod-<sha>` (тот же GHCR-пакет, что у прода) |
| Близость к проду | средняя                               | высокая: повторяет `deploy` из `release.yml`     |

Стек staging не меняется: правка `apps/**` в `main` по-прежнему обновляет его автоматически.

Адрес preprod содержит `:8443` по той же причине, что и staging: наружу проброшен 8443 → 443
(домашний NAT). Это **стендовое** значение: в прод-адреса порт не переносится — прод на 443,
без порта, и это проверяется guard'ом `pnpm check:prod-urls` в `release.yml` (issue #142).

## Как устроено

1. `.github/workflows/preprod.yml` — job `images`: сборка `api`, `api-migrations`, `web`
   (build-args с адресом preprod) и пуш в GHCR с тегом `preprod-<sha>`; job `deploy` —
   SSH `deploy-image <sha>`.
2. На хосте принудительная команда (`deploy/staging/ssh-deploy.sh`, режим `deploy-image`) берёт
   `scripts/deploy-preprod.sh` из `origin/main` деплой-клона и запускает его.
3. `scripts/deploy-preprod.sh`: `compose pull` → сверка тегов с `.env` → `run --rm -T migrations`
   → `up -d --remove-orphans` → healthcheck на loopback (`:3021/api/health`, `:3020/`) →
   запись `.deployed-sha` в каталог стека.

Почему тег `preprod-<sha>`, а не отдельные пакеты: preprod тренирует ровно те же GHCR-пакеты,
что и прод (`hair-lab-api`, `hair-lab-api-migrations`, `hair-lab-web`), просто с другим префиксом
тега. Ретенция GHCR (`ghcr-cleanup.yml`) удаляет только старые `sha`, `preprod-*` не трогает.

## Проверка результата

- Actions: прогон `Preprod` зелёный;
- на хосте: `cat /home/deployer/hair-lab-preprod/.deployed-sha` — sha совпадает с выбранным `ref`;
- healthcheck: `curl -sS http://127.0.0.1:3021/api/health` (с хоста) или
  `curl -sS https://preprod.dnikulshin.ru:8443/api/health` (если поднят nginx, см. `install.md`).

## Откат

_Run workflow_ с `ref` = sha предыдущего коммита из истории `main`: соберутся и выкатятся образы
`preprod-<sha>` того коммита. Автоотката здесь нет намеренно — это ручной контур.

## Безопасность

- Используется тот же ключ Actions, что у staging: он ограничен принудительной командой
  (`deploy` / `deploy-image`) и не даёт шелла (issue #128). Отдельный ключ не нужен.
- Контур закрыт от индексации (`X-Robots-Tag: noindex` в nginx-конфиге), платежи и почта выключены
  (`PAYMENTS_MODE=off`, `SMTP_HOST=`), данные — демо-сид.
- Секретов на preprod нет: `.env` лежит на хосте, в git не попадает.

## Ограничения

- Автодеплоя нет by design: обновление preprod — осознанное действие перед продом.
- Прод-деплой на VPS и его healthcheck/автооткат — отдельная задача (#136).
