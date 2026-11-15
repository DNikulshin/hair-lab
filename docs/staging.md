# Staging: `hair-lab.dnikulshin.ru:8443`

Учебный (staging) контур салона: отдельный стек на той же машине, что и разработка, со своей БД,
своими портами и своим `.env`. Публичный адрес — **`https://hair-lab.dnikulshin.ru:8443`**:
наружу проброшены **8443 → локальный 443** (внешний 443 не проброшен) и **2222 → локальный 22**
(только для CD, ключ ограничен принудительной командой, issue #130), TLS — существующий
wildcard-сертификат `*.dnikulshin.ru` (`/etc/ssl/dnikulshin/{fullchain.pem,key.pem}`).

Общий контекст развёртывания — `docs/deploy.md` (образы, GHCR, compose, миграции).

## Что где лежит

| Что            | Где                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Каталог стека  | `/home/deployer/hair-lab-staging` (пользователь `deployer`: compose-файл, `.env` с правами `600`, скрипт деплоя)                   |
| Деплой-клон    | `/home/deployer/hair-lab-deploy` — отдельный от рабочего клона агента, CD переключает коммиты только в нём                         |
| CD             | workflow `staging.yml`: merge в `main` → сборка на хосте → миграции → `up -d` → healthcheck                                        |
| Compose-проект | `-p hair-lab-staging` (том `hair-lab-staging_db-data`, контейнеры `hair-lab-staging-*`)                                            |
| Порты          | `127.0.0.1:3010` (web), `127.0.0.1:3011` (api); 3000/3001 — локальный `pnpm dev`                                                   |
| nginx          | `/etc/nginx/sites-available/hair-lab-staging` из `deploy/nginx/hair-lab.staging.dnikulshin.ru.conf`                                |
| Образы         | собираются локально на хосте из задеплоенного коммита: `hair-lab-api:local`, `hair-lab-api-migrations:local`, `hair-lab-web:local` |
| БД             | сервис `db` (postgres:17-alpine), наружу не публикуется; миграции — сервис `migrations`                                            |

Почему не `/opt`: snap-версия Docker не видит `/opt` — `docker compose` из этого каталога падает
с `compose file "/var/lib/snapd/void/…" is invalid`. Из `/root` и `/home` работает.

Почему не `/root` (как было до #125): CD идёт по SSH под пользователем `deployer`, а у него нет
и не должно быть доступа к `/root` и к домашнему каталогу агента (`/home/dev/.pi` — ключи
провайдеров, `.env` проекта).

Почему отдельный проект: имя `hair-lab` из `name:` в compose-файле занято более ранней попыткой,
её том `hair-lab_db-data` инициализирован другим паролем (`prisma migrate deploy` падал с
`P1000: Authentication failed`). `-p hair-lab-staging` даёт свой том и свои контейнеры.

## Обновление: CD после merge

Стенд обновляется автоматически: merge в `main` → workflow **Staging** (`.github/workflows/staging.yml`)
→ `scripts/deploy-staging.sh` на хосте (его берёт из `origin/main` принудительная команда) →
сборка образов из деплой-клона → миграции → `up -d`
→ healthcheck `/api/health` и `/`. Прогон виден в Actions (окружение `staging`), повтор и откат —
кнопкой _Run workflow_.

Что важно знать:

- **Сборка идёт на хосте, а не в CI**: порт `:8443` вшивается в `NEXT_PUBLIC_*` на сборке web и
  отличается от прод-значений, поэтому образы staging в GHCR не публикуются.
- **Docs-only коммиты стенд не трогают**: job `deploy` пропускается по `scripts/changed-components.mjs`.
- **Деплой берёт код из `/home/deployer/hair-lab-deploy`**, а не из рабочего клона агента: CD
  переключает коммиты только там. Незакоммиченные правки на стенд не попадают — сначала merge.
- **Ключ Actions не даёт шелла**: в `authorized_keys` он ограничен принудительной командой
  и опцией `restrict` — украденный ключ умеет только задеплоить коммит из `main`. У команды два
  режима: `deploy <ref>` (staging, сборка на хосте) и `deploy-image <ref>` (preprod, образы
  из GHCR — `docs/preprod.md`). По адресам (`from=`) не ограничиваем: GitHub отдаёт 8350 диапазонов,
  это 151 КБ в одной строке. Поэтому же `scp` этим ключом недоступен.
- **Коммит и время деплоя**: `/home/deployer/hair-lab-staging/.deployed-sha`.
- **Откат**: Actions → Staging → _Run workflow_, `ref` = sha предыдущего коммита из истории `main`.
- **Лог прогона на хосте**: `journalctl` не нужен, всё в Actions; при падении healthcheck в лог
  попадают последние 60 строк `docker compose logs api web`.

Разовая настройка (пользователь `deployer`, перенос стека из `/root`, SSH-ключ, секреты) —
`deploy/staging/install.md`.

Ручной деплой остаётся как аварийный путь и делает то же самое:

```bash
sudo -u deployer bash -c 'SSH_ORIGINAL_COMMAND="deploy main" /home/deployer/hair-lab-staging/ssh-deploy.sh'
```

`NEXT_BASE_PATH` не задаём (в отличие от локального запуска за прокси code-server).

## Диагностика CD (грабли, собранные при настройке)

Всё ниже проверено на этом стенде; при переносе схемы на прод не повторять.

**Логи Actions с этого хоста не скачиваются**: `results-receiver.actions.githubusercontent.com`
и `*.blob.core.windows.net` режутся сетью (`TLS handshake timeout`). Признак «упало» видно, а текст —
нет. Поэтому диагностика идёт с самого хоста:

```bash
# аутентификация проверяется локально (from= не используется):
ssh -i /home/dev/.ssh/hair-lab-staging-cd -p 22 deployer@127.0.0.1 'echo ping'
#   «отказано: разрешена только команда…» (код 64) → ключ работает, команда отвергнута
#   «Permission denied (publickey,password)»       → проблема в authorized_keys/правах

# боевой прогон, тот же, что делает Actions, — с полным выводом:
ssh -i /home/dev/.ssh/hair-lab-staging-cd -p 22 deployer@127.0.0.1 'deploy main'
```

Частые причины отказа (все встречались здесь):

| Симптом                                                     | Причина                                                                   | Лечение                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Permission denied (publickey,password)`, ключ в файле есть | в `command=` нет кавычек — sshd молча игнорирует строку                   | `command="<путь>"`, см. `install.md` шаг 4.4                                          |
| То же, файла нет / права шире `600`                         | `authorized_keys` не установлен или `strictmodes` отбрасывает             | `chown deployer`, `chmod 600`, `.ssh` 700, домашний 750                               |
| `Connection refused` с раннера                              | порт не проброшен: наружу нужны 8443 → 443 и 2222 → 22                    | правило на роутере + `ufw allow 22/tcp` + `STAGING_SSH_PORT=2222`                     |
| Сверка образов падает, в выводе нет `migrations`            | `migrations` в профиле, а `compose config --images` профили не показывает | так и задумано: guard сверяет `api`/`web`, образ миграций проверяется отдельно (#134) |
| `.deployed-sha` нет                                         | прогон только с `changes` (docs-only) — `deploy` пропущен                 | ожидаемо; правка `apps/**` деплоит                                                    |

## Демо-данные

`scripts/seed-staging.sql` — идемпотентный сид (3 категории, 4 услуги, 2 мастера, расписание пн–сб
10:00–20:00, только вымышленные данные):

```bash
sudo -u deployer bash -c 'cd /home/deployer/hair-lab-staging && docker compose -p hair-lab-staging -f docker-compose.prod.yml exec -T db psql -U hair_lab -d hair_lab' < scripts/seed-staging.sql
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
sudo -u deployer bash -c 'cd /home/deployer/hair-lab-staging && docker compose -p hair-lab-staging -f docker-compose.prod.yml down'
```

Том с БД сохраняется; `down -v` удалит данные стенда.
