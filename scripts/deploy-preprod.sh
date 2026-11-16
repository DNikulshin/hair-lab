#!/usr/bin/env bash
# Деплой preprod-контура образом из GHCR (issue #139) — ручной прогон прод-пути.
#
# Запускается принудительной командой ключа (`deploy/staging/ssh-deploy.sh`, режим
# `deploy-image <ref>`) или вручную. В отличие от staging здесь ничего не собирается на хосте:
# образы уже лежат в GHCR с тегом `preprod-<sha>`, стек их только пуллит — ровно как `deploy`
# в `release.yml` делает на проде.
#
#   ./deploy-preprod.sh <ref>
#
# `ref` — коммит из истории `main` (или `main`); тег образа собирается как `<PREFIX><sha>`.
#
# Переменные окружения (по умолчанию — этот стенд):
#   PREPROD_STACK_DIR   каталог стека (compose-файл и `.env`) — $HOME/hair-lab-preprod
#   PREPROD_PROJECT     имя compose-проекта — hair-lab-preprod
#   PREPROD_TAG_PREFIX  префикс тега в GHCR — `preprod-`
#   PREPROD_API_PORT    loopback-порт api для healthcheck — 3021
#   PREPROD_WEB_PORT    loopback-порт web для проверки — 3020
set -euo pipefail

STACK_DIR="${PREPROD_STACK_DIR:-$HOME/hair-lab-preprod}"
STAGING_DEPLOY_DIR="${STAGING_DEPLOY_DIR:-$HOME/hair-lab-deploy}"
PROJECT="${PREPROD_PROJECT:-hair-lab-preprod}"
TAG_PREFIX="${PREPROD_TAG_PREFIX:-preprod-}"
API_PORT="${PREPROD_API_PORT:-3021}"
WEB_PORT="${PREPROD_WEB_PORT:-3020}"
REF="${1:-main}"
COMPOSE=(docker compose -p "$PROJECT" -f "$STACK_DIR/docker-compose.prod.yml")

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() {
  log "ОШИБКА: $*" >&2
  exit 1
}

exec 9>"${TMPDIR:-/tmp}/hair-lab-preprod-deploy.lock"
flock -w 1800 9 || fail "деплой уже идёт (не дождались блокировки)"

[[ -f "$STACK_DIR/.env" ]] || fail "нет $STACK_DIR/.env — окружение стека не в git"
[[ -d "$STAGING_DEPLOY_DIR/.git" ]] || fail "нет деплой-клона $STAGING_DEPLOY_DIR"

# --- определяем коммит и тег образа ----------------------------------------
cd "$STAGING_DEPLOY_DIR"
git fetch --prune --force origin '+refs/heads/*:refs/remotes/origin/*'

if git rev-parse --verify --quiet "origin/$REF^{commit}" >/dev/null; then
  TARGET="$(git rev-parse "origin/$REF^{commit}")"
elif git rev-parse --verify --quiet "$REF^{commit}" >/dev/null; then
  TARGET="$(git rev-parse "$REF^{commit}")"
else
  fail "в деплой-клоне нет $REF: нужен коммит из истории main"
fi

IMAGE_TAG="${TAG_PREFIX}${TARGET}"
export IMAGE_TAG
log "деплой preprod из GHCR, тег $IMAGE_TAG: $(git log -1 --pretty=%s "$TARGET")"

# --- compose стека из репозитория (issue #173) ------------------------------
# Образы тут из GHCR, но compose — копия в каталоге стека: без синхронизации изменения из
# `main` (например, новые переменные окружения `web`) до контура не доезжают. Берём файл из
# целевого коммита (без checkout: рабочее дерево деплой-клона не трогаем) и накатываем только
# при отличии; старую копию сохраняем.
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

# Сверяем, что compose берёт образы именно с этим тегом: разошедшийся `.env` иначе молча
# поднял бы старую версию (как в staging, но здесь тег приходит извне, а не собирается).
actual="$("${COMPOSE[@]}" config --images | grep -E '^ghcr\.io/' | sort || true)"
[[ -n "$actual" ]] || fail "в $STACK_DIR/.env не заданы GHCR_IMAGE_* (нужны ghcr.io/... образы)"
while read -r image; do
  [[ "$image" == *":$IMAGE_TAG" ]] || fail "compose подставит $image, ожидался тег :$IMAGE_TAG"
done <<<"$actual"

# --- тянем образы и перезапускаем ------------------------------------------
# Метка стенда для плашки на странице (issue #170): `web` читает их как runtime-переменные,
# поэтому пишем в `.env` стека (compose прокидывает их в контейнер). Образы тут из GHCR,
# то есть одинаковые с продом — различие задаётся именно этими переменными.
set_env_var() { # файл ключ значение — заменяет строку KEY=..., не дублирует ключ
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$file" >"$tmp" || true
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  cat "$tmp" >"$file" # cat, а не mv: у `.env` права 600, их надо сохранить
  rm -f "$tmp"
}

DEPLOYED_AT="$(date -u +%FT%TZ)"
set_env_var "$STACK_DIR/.env" DEPLOY_ENV preprod
set_env_var "$STACK_DIR/.env" DEPLOY_SHA "$TARGET"
set_env_var "$STACK_DIR/.env" DEPLOY_AT "$DEPLOYED_AT"

log "pull образов"
"${COMPOSE[@]}" pull
log "миграции"
"${COMPOSE[@]}" run --rm -T migrations
log "перезапуск контейнеров"
"${COMPOSE[@]}" up -d --remove-orphans
docker image prune -f >/dev/null

# --- проверка (loopback: внешний nginx для preprod не обязателен) -----------
log "проверка http://127.0.0.1:$API_PORT/health и :$WEB_PORT"
ready=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$API_PORT/health" &&
    curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:$WEB_PORT/"; then
    ready=1
    break
  fi
  sleep 2
done

if ((ready == 0)); then
  "${COMPOSE[@]}" logs --tail=60 api web || true
  fail "preprod не отвечает на loopback-портах $API_PORT/health и $WEB_PORT после перезапуска"
fi

printf '%s %s\n' "$TARGET" "$DEPLOYED_AT" >"$STACK_DIR/.deployed-sha"
log "готово: preprod на коммите $TARGET (тег $IMAGE_TAG)"
