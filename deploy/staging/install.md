# Разовая настройка CD на staging

Короткая версия: на хосте появляется пользователь деплоя, стек переезжает в его домашний
каталог, GitHub Actions получает доступ по SSH. После этого каждый merge в `main` обновляет
`https://hair-lab.dnikulshin.ru:8443` без ручных шагов (workflow `staging.yml`, issue #125).

Всё ниже выполняется один раз, командами с `sudo` — то есть владельцем, а не агентом.

## Почему отдельный пользователь, а не `dev`

Агент работает под `dev`, у которого в домашнем каталоге лежат ключи провайдеров моделей
(`/home/dev/.pi`) и `.env` проекта. Ключ из GitHub Actions не должен открывать этот каталог,
поэтому деплой идёт под отдельным пользователем `deployer`: ему доступны только стек staging
и деплой-клон репозитория.

## 1. Пользователь деплоя

```bash
sudo adduser --disabled-password --gecos "" deployer
sudo usermod -aG docker deployer
```

`docker`-группа нужна, чтобы сборка и `compose up` работали без sudo (snap-докер на этом хосте
пускает `dev` именно так).

## 2. Перенести стек из `/root` в домашний каталог `deployer`

Том БД (`hair-lab-staging_db-data`) принадлежит Docker и при переезде каталога не меняется:
данные и записи остаются, простой — только перезапуск контейнеров.

```bash
# остановить текущий стек (том остаётся)
sudo bash -c 'cd /root/hair-lab-staging && docker compose -p hair-lab-staging -f docker-compose.prod.yml down'

# перенести каталог стека (compose-файл + .env + права)
sudo install -d -o deployer -g deployer -m 700 /home/deployer/hair-lab-staging
sudo cp -a /root/hair-lab-staging/. /home/deployer/hair-lab-staging/
sudo chown -R deployer:deployer /home/deployer/hair-lab-staging
sudo chmod 600 /home/deployer/hair-lab-staging/.env
sudo chmod 700 /home/deployer/hair-lab-staging

# поднять стек из нового каталога и проверить
sudo -u deployer docker compose -p hair-lab-staging \
  -f /home/deployer/hair-lab-staging/docker-compose.prod.yml up -d --remove-orphans
curl -sS https://hair-lab.dnikulshin.ru:8443/api/health
```

Миграции при переезде не нужны: код и том БД те же. Каталог `/root/hair-lab-staging` можно
оставить как резервную копию `.env` или удалить после успешной проверки — на него больше
ничего не ссылается.

## 3. Деплой-клон репозитория

Репозиторий публичный, поэтому клонирование не требует ни ключей, ни токена:

```bash
sudo -u deployer git clone https://github.com/DNikulshin/hair-lab.git /home/deployer/hair-lab-deploy
```

Деплой-клон — отдельный от рабочего клона агента (`/home/dev/projects/hair-lab`): CD
переключает в нём коммиты, и делать это в каталоге, где идёт разработка, нельзя.

`.env`: в нём нужны `GHCR_IMAGE_API=hair-lab-api`, `GHCR_IMAGE_MIGRATIONS=hair-lab-api-migrations`,
`GHCR_IMAGE_WEB=hair-lab-web` и `IMAGE_TAG=local` — образы собираются на хосте под тегом `local`.
Скрипт деплоя сверяет это через `compose config --images` и падает с подсказкой, если в `.env`
осталось что-то другое.

## 4. SSH-ключ и принудительная команда для GitHub Actions

Ключ не должен давать шелл: пользователь `deployer` состоит в группе `docker`, а это эквивалент
root — поэтому в `authorized_keys` ключ ограничен принудительной командой, а не только адресами.

Почему не `from="…"`: GitHub публикует **8350** диапазонов адресов Actions (5622 IPv4 + 2728 IPv6),
это строка на **151 КБ**, которую неудобно и рискованно редактировать, а при смене диапазонов
деплой молча падал бы с `Permission denied (publickey)`. Принудительная команда даёт строже:
украденный ключ умеет только «задеплой коммит из `main`».

**4.1. Ключ.** Приватную часть кладёт в секрет тот, у кого есть `gh` (в этой настройке — агент
под `dev`), публичная идёт на хост:

```bash
ls -l /home/dev/.ssh/hair-lab-staging-cd.pub      # ssh-ed25519 …, отпечаток проверяется ниже
```

**4.2. Проброс порта.** Хост за домашним NAT: наружу проброшены только 8443 → 443 (сайт) и
**2222 → 22** (SSH для CD). Правило ставится на роутере (владелец), на хосте — разрешение ufw:

```bash
sudo ufw status numbered | grep -E '22|8443'
sudo ufw allow 22/tcp        # если 22 закрыт; `ufw` по умолчанию DROP
```

В репозитории это переменная `STAGING_SSH_PORT=2222` (шаг 5): без неё workflow стучится в 22 и
получает `Connection refused`. При смене домашнего IP деплой отвалится, пока DNS
`hair-lab.dnikulshin.ru` не укажет на новый адрес.

**4.3. Принудительная команда.** `deploy/staging/ssh-deploy.sh` из репозитория кладётся в каталог
стека и принадлежит `deployer`:

```bash
sudo install -o deployer -g deployer -m 700 \
  /home/dev/projects/hair-lab/deploy/staging/ssh-deploy.sh \
  /home/deployer/hair-lab-staging/ssh-deploy.sh
```

**4.4. `authorized_keys`.** Одна строка, ключ ограничен командой и опциями `restrict`
(без `scp`, проброса агента, pty и форвардинга):

```bash
sudo install -d -o deployer -g deployer -m 700 /home/deployer/.ssh
PUB=$(sudo cat /home/dev/.ssh/hair-lab-staging-cd.pub)
echo "restrict,command=\"/home/deployer/hair-lab-staging/ssh-deploy.sh\" $PUB" |
  sudo tee /home/deployer/.ssh/authorized_keys >/dev/null
sudo chown deployer:deployer /home/deployer/.ssh/authorized_keys
sudo chmod 600 /home/deployer/.ssh/authorized_keys
sudo cut -c1-100 /home/deployer/.ssh/authorized_keys
sudo ssh-keygen -lf /home/deployer/.ssh/authorized_keys   # ожидаем SHA256:NMfj…
```

**Кавычки вокруг значения `command=` обязательны.** Без них sshd (проверено на OpenSSH 10.2)
молча игнорирует строку ключа: вход даёт `Permission denied (publickey,password)`, а в логе нет
внятной причины. Поэтому в команде выше пара `\"…\"` вокруг пути — не опечатка.

**4.5. Проверка правды.** Прогон workflow (шаг 6) — не единственная проверка: `authorized_keys`
без `from=`, поэтому ключ можно проверить локально, и это дешевле, чем ждать раннер:

```bash
ssh -i /home/dev/.ssh/hair-lab-staging-cd -p 22 deployer@127.0.0.1 'echo ping'
```

Ожидаемо: `отказано: разрешена только команда «deploy <ref>»…` и код 64 — это значит, что
**аутентификация прошла**, а принудительная команда отвергла лишний аргумент. Если видишь
`Permission denied (publickey,password)` — проблема в `authorized_keys` (нет файла, не те права
или нет кавычек в `command=`). Боевой запуск (он же выполняет Actions):

```bash
ssh -i /home/dev/.ssh/hair-lab-staging-cd -p 22 deployer@127.0.0.1 'deploy main'
```

```bash
sudo sshd -T | grep -E '^(pubkeyauthentication|passwordauthentication)'
getent passwd deployer | cut -d: -f7                    # ожидаем /bin/bash
```

Обновление `ssh-deploy.sh` — вручную командой `install` из шага 4.3: ключ `scp` не разрешает.

## 5. Секрет и переменная репозитория

```bash
gh secret set STAGING_SSH_KEY < /home/dev/.ssh/hair-lab-staging-cd
gh variable set STAGING_HOST --body "hair-lab.dnikulshin.ru"   # адрес хоста для SSH (порт 22)
```

Необязательная переменная `STAGING_USER` (по умолчанию `deployer`), порт SSH — `STAGING_SSH_PORT`
(`2222` на этом хосте). Пути на хосте в workflow не передаются: они зашиты в принудительной
команде и в `$HOME/hair-lab-deploy` деплой-клона.

Окружение `staging` создаётся само при первом запуске workflow; в нём можно включить
required reviewers или свои секреты (Settings → Environments).

## 6. Проверка

1. Actions → **Staging** → _Run workflow_, `ref` = `main`.
2. Дождаться зелёного прогона (первая сборка на хосте — 5–7 минут).
3. Проверить на хосте и снаружи:

```bash
sudo -u deployer cat /home/deployer/hair-lab-staging/.deployed-sha   # sha + время
curl -sS https://hair-lab.dnikulshin.ru:8443/api/health
```

4. Смержить любой PR с правкой `apps/api/**` или `apps/web/**` — деплой должен запуститься сам.
   Docs-only PR стенд не трогает (job `deploy` пропускается).

## Откат и выключение

- **Откат**: Actions → Staging → _Run workflow_, в `ref` — sha предыдущего коммита из истории
  `main`. Скрипт соберёт образы этого коммита и перезапустит стек.
- **Ручной деплой** (если Actions недоступен) — теми же скриптами на хосте:

  ```bash
  sudo -u deployer bash -c 'SSH_ORIGINAL_COMMAND="deploy main" /home/deployer/hair-lab-staging/ssh-deploy.sh'
  ```

- **Выключить CD**: Actions → Staging → _Disable workflow_. Стенд продолжит работать на
  последнем задеплоенном коммите.
