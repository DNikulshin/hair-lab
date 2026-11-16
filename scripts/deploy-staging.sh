#!/usr/bin/env bash
# Автоматический деплой staging (issue #125).
#
# Запускается с хоста staging принудительной командой ключа Actions (`deploy/staging/ssh-deploy.sh`,
# issue #128) или вручную. Сам скрипт всегда берётся из `origin/main` деплой-клона
# и запускается из временной копии, поэтому `git checkout` его не подменяет.
#
#   ./deploy-staging.sh [ref]
#
# `ref` — ветка или коммит из деплой-клона, по умолчанию `origin/main`. Откат — тот же скрипт
# с sha предыдущего коммита из истории `main`:
#
#   ./deploy-staging.sh 8a9c947
#
# Почему сборка локальная, а не из GHCR: staging-адрес с портом `:8443` вшивается в web-бандл
# на этапе сборки и отличается от прод-значений (см. `docs/staging.md`).
#
# Переменные окружения (по умолчанию — значения этого стенда):
#   STAGING_STACK_DIR    каталог стека (compose-файл и `.env`); по умолчанию — каталог скрипта
#   STAGING_DEPLOY_DIR   деплой-клон репозитория ($HOME/hair-lab-deploy)
#   STAGING_PROJECT      имя compose-проекта (hair-lab-staging)
#   STAGING_PUBLIC_URL   публичный адрес стенда (https://hair-lab.dnikulshin.ru:8443)
#   NEXT_PUBLIC_SITE_*   бренд и город, попадают в web на сборке
set -euo pipefail

STACK_DIR="${STAGING_STACK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
STAGING_DEPLOY_DIR="${STAGING_DEPLOY_DIR:-$HOME/hair-lab-deploy}"
PROJECT="${STAGING_PROJECT:-hair-lab-staging}"
PUBLIC_URL="${STAGING_PUBLIC_URL:-https://hair-lab.dnikulshin.ru:8443}"
REF="${1:-main}"
COMPOSE=(docker compose -p "$PROJECT" -f "$STACK_DIR/docker-compose.prod.yml")

# Значения, которые вшиваются в web на сборке.
SITE_NAME="${NEXT_PUBLIC_SITE_NAME:-Стриж Lab}"
SITE_SHORT_NAME="${NEXT_PUBLIC_SITE_SHORT_NAME:-Стриж}"
SITE_CITY="${NEXT_PUBLIC_SITE_CITY:-Москва}"
SITE_TIMEZONE="${NEXT_PUBLIC_SITE_TIMEZONE:-Europe/Moscow}"

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() {
  log "ОШИБКА: $*" >&2
  exit 1
}

# Деплой идёт в один поток: ручной запуск поверх автодеплоя ждёт, а не собирает те же образы
# параллельно. Блокировка снимается сама при завершении процесса, ожидание ограничено 30 мин.
exec 9>"${TMPDIR:-/tmp}/hair-lab-staging-deploy.lock"
flock -w 1800 9 || fail "деплой уже идёт (не дождались блокировки)"

[[ -f "$STACK_DIR/.env" ]] || fail "нет $STACK_DIR/.env — окружение стека не в git"
[[ -d "$STAGING_DEPLOY_DIR/.git" ]] || fail "нет деплой-клона $STAGING_DEPLOY_DIR"

# --- код нужного коммита в деплой-клоне -------------------------------------
cd "$STAGING_DEPLOY_DIR"
git fetch --prune --force origin '+refs/heads/*:refs/remotes/origin/*'

if git rev-parse --verify --quiet "origin/$REF^{commit}" >/dev/null; then
  TARGET="$(git rev-parse "origin/$REF^{commit}")"
elif git rev-parse --verify --quiet "$REF^{commit}" >/dev/null; then
  TARGET="$(git rev-parse "$REF^{commit}")"
else
  fail "в деплой-клоне нет $REF: нужен коммит из истории main"
fi

git -c advice.detachedHead=false checkout --force --detach "$TARGET"
git clean -fdq
log "деплой $TARGET: $(git log -1 --pretty=%s)"

# --- compose стека из репозитория (issue #173) ------------------------------
# compose живёт в каталоге стека копией, а не в git: без синхронизации изменения из `main`
# (например, новые переменные окружения `web`) до стенда не доезжают — внешне деплой зелёный,
# а внутри старый конфиг. Берём файл именно из целевого коммита и накатываем только при отличии;
# предыдущая копия сохраняется с меткой времени.
DESIRED_COMPOSE="$STACK_DIR/docker-compose.prod.yml.desired"
git -C "$STAGING_DEPLOY_DIR" show "$TARGET:docker-compose.prod.yml" >"$DESIRED_COMPOSE" ||
  fail "в коммите $TARGET нет docker-compose.prod.yml"
if cmp -s "$DESIRED_COMPOSE" "$STACK_DIR/docker-compose.prod.yml"; then
  rm -f "$DESIRED_COMPOSE"
else
  cp -a "$STACK_DIR/docker-compose.prod.yml" \
    "$STACK_DIR/docker-compose.prod.yml.bak.$(date -u +%Y%m%d-%H%M%S)" 2>/dev/null || true
  mv "$DESIRED_COMPOSE" "$STACK_DIR/docker-compose.prod.yml"
  log "compose стека обновлён из коммита $TARGET"
fi
"${COMPOSE[@]}" config -q || fail "compose стека невалиден: $STACK_DIR/docker-compose.prod.yml"

# --- сборка образов ---------------------------------------------------------
log "сборка api"
docker build -q -f apps/api/Dockerfile -t hair-lab-api:local .
log "сборка образа миграций"
docker build -q -f apps/api/Dockerfile --target migrations -t hair-lab-api-migrations:local .
log "сборка web"
docker build -q -f apps/web/Dockerfile -t hair-lab-web:local \
  --build-arg NEXT_PUBLIC_SITE_NAME="$SITE_NAME" \
  --build-arg NEXT_PUBLIC_SITE_SHORT_NAME="$SITE_SHORT_NAME" \
  --build-arg NEXT_PUBLIC_SITE_URL="$PUBLIC_URL" \
  --build-arg NEXT_PUBLIC_API_URL="$PUBLIC_URL/api" \
  --build-arg NEXT_PUBLIC_SITE_CITY="$SITE_CITY" \
  --build-arg NEXT_PUBLIC_SITE_TIMEZONE="$SITE_TIMEZONE" .

# Compose подставляет образы из `.env` (GHCR_IMAGE_* + IMAGE_TAG). Если они разойдутся
# с собранными тегами, стенд молча поднял бы старые образы — поэтому сверяем явно.
#
# Сверяем только те образы, которые поднимет `up -d` (`api`, `web`): сервис `migrations`
# объявлен с `profiles: [migrations]`, а `compose config --images` профильные сервисы не
# показывает (issue #134). Наличие образа миграций проверяем отдельно.
for image in hair-lab-api:local hair-lab-web:local hair-lab-api-migrations:local; do
  docker image inspect "$image" >/dev/null 2>&1 || fail "образ $image не собран"
done
expected="$(printf '%s\n' hair-lab-api:local hair-lab-web:local | sort)"
actual="$("${COMPOSE[@]}" config --images | grep -E '^hair-lab-' | sort || true)"
if [[ "$actual" != "$expected" ]]; then
  fail "compose подставит другие образы, чем собраны.
Сейчас:   ${actual//$'\n'/ }
Ожидалось: ${expected//$'\n'/ }
Проверьте GHCR_IMAGE_* и IMAGE_TAG в $STACK_DIR/.env (нужны hair-lab-* и IMAGE_TAG=local)"
fi

# --- миграции и перезапуск --------------------------------------------------
# Метка стенда для плашки на странице (issue #170). `web` читает их как runtime-переменные,
# поэтому пишем в `.env` стека (compose прокидывает их в контейнер), а не в build-args:
# один и тот же образ должен вести себя по-разному на стенде и на проде.
set_env_var() { # файл ключ значение — заменяет строку KEY=..., не дублирует ключ
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$file" >"$tmp" || true
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  cat "$tmp" >"$file" # cat, а не mv: у `.env` права 600, их надо сохранить
  rm -f "$tmp"
}

DEPLOYED_AT="$(date -u +%FT%TZ)"
set_env_var "$STACK_DIR/.env" DEPLOY_ENV staging
set_env_var "$STACK_DIR/.env" DEPLOY_SHA "$TARGET"
set_env_var "$STACK_DIR/.env" DEPLOY_AT "$DEPLOYED_AT"

log "миграции"
"${COMPOSE[@]}" run --rm -T migrations
log "перезапуск контейнеров"
"${COMPOSE[@]}" up -d --remove-orphans
docker image prune -f >/dev/null

# --- проверка после запуска -------------------------------------------------
log "проверка $PUBLIC_URL"
ready=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 -o /dev/null "$PUBLIC_URL/api/health" &&
     curl -fsS --max-time 5 -o /dev/null "$PUBLIC_URL/"; then
    ready=1
    break
  fi
  sleep 2
done

if ((ready == 0)); then
  "${COMPOSE[@]}" logs --tail=60 api web || true
  fail "стенд не отвечает на $PUBLIC_URL/api/health и $PUBLIC_URL/ после перезапуска"
fi

printf '%s %s\n' "$TARGET" "$DEPLOYED_AT" >"$STACK_DIR/.deployed-sha"
log "готово: $PUBLIC_URL на коммите $TARGET"
