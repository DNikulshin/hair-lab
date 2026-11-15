#!/usr/bin/env bash
# Прод-деплой одним скриптом (issue #136): на VPS его присылает `release.yml` по SSH
# (`ssh … 'bash -s' < scripts/deploy-prod.sh`), поэтому логика живёт в репозитории,
# а не в heredoc внутри workflow, и её можно прогнать локально с подменённым `docker`.
#
# Задача: обновление прода — одно действие, а при неудаче стенд возвращается на предыдущий тег
# сам, без ручных `docker`-команд на сервере.
#
# Переменные (обязательные: APP_DIR, IMAGE_TAG):
#   APP_DIR     каталог стека на сервере (compose-файл и `.env`)
#   IMAGE_TAG   тег образов этого деплоя (обычно git sha)
#   HEALTH_TIMEOUT  сколько секунд ждать healthcheck (по умолчанию 60)
#   RUN_CMD     чем запускать compose (по умолчанию `docker compose`; в тестах — подмена)
set -euo pipefail

APP_DIR="${APP_DIR:?APP_DIR не задан}"
IMAGE_TAG="${IMAGE_TAG:?IMAGE_TAG не задан}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
MARKER=".deployed-sha"
# shellcheck disable=SC2206 # RUN_CMD намеренно разбивается на слова: `docker compose` / тестовая подмена
COMPOSE=(${RUN_CMD:-docker compose} -f "$COMPOSE_FILE")

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() {
  log "ОШИБКА: $*" >&2
  exit 1
}

cd "$APP_DIR" || fail "нет каталога стека $APP_DIR"
[[ -f "$COMPOSE_FILE" ]] || fail "нет $APP_DIR/$COMPOSE_FILE"
[[ -f .env ]] || fail "нет $APP_DIR/.env"

# Порт берём из `.env` стека: healthcheck идёт на loopback, снаружи nginx.
env_value() {
  local key="$1" default="$2"
  local value
  value="$(grep -E "^${key}=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  printf '%s' "${value:-$default}"
}
API_PORT="$(env_value API_PORT 3001)"
WEB_PORT="$(env_value WEB_PORT 3000)"

# Предыдущий задеплоенный тег: из маркера. Нет маркера — откатываться некуда.
PREVIOUS_TAG=""
if [[ -f "$MARKER" ]]; then
  PREVIOUS_TAG="$(awk 'NR==1 {print $1}' "$MARKER")"
fi

healthcheck() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while ((SECONDS < deadline)); do
    if curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:${API_PORT}/health" &&
      curl -fsS --max-time 5 -o /dev/null "http://127.0.0.1:${WEB_PORT}/"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

diagnostics() {
  log "диагностика:"
  "${COMPOSE[@]}" ps || true
  "${COMPOSE[@]}" logs --tail=40 api web || true
}

write_marker() {
  printf '%s %s\n' "$1" "$(date -u +%FT%TZ)" >"$MARKER"
}

log "деплой $IMAGE_TAG (предыдущий: ${PREVIOUS_TAG:-нет})"

# Пакеты GHCR публичные, поэтому логин не обязателен: если PAT задан — используем,
# иначе `pull` идёт анонимно (issue #139).
if [[ -n "${GHCR_PAT:-}" ]]; then
  printf '%s' "$GHCR_PAT" | docker login ghcr.io -u "${GHCR_USER:?GHCR_USER не задан}" --password-stdin >/dev/null
  log "docker login ghcr.io выполнен"
fi

log "pull образов"
"${COMPOSE[@]}" pull

log "миграции"
"${COMPOSE[@]}" run --rm -T migrations

log "перезапуск контейнеров"
"${COMPOSE[@]}" up -d --remove-orphans
docker image prune -f >/dev/null || true

log "healthcheck 127.0.0.1:${API_PORT}/health и :${WEB_PORT} (ожидание до ${HEALTH_TIMEOUT}с)"
if healthcheck; then
  write_marker "$IMAGE_TAG"
  log "готово: прод на $IMAGE_TAG"
  exit 0
fi

diagnostics

# Откат: поднимаем предыдущий тег тем же compose-файлом. `.env` уже перезаписан новым
# IMAGE_TAG, поэтому переменная передаётся в окружение — она приоритетнее `.env`.
if [[ -z "$PREVIOUS_TAG" || "$PREVIOUS_TAG" == "$IMAGE_TAG" ]]; then
  fail "healthcheck не прошёл, откатываться некуда (нет маркера с предыдущим тегом) — нужен ручной разбор"
fi

log "healthcheck не прошёл — откат на $PREVIOUS_TAG"
IMAGE_TAG="$PREVIOUS_TAG" "${COMPOSE[@]}" pull ||
  fail "откат: не удалось скачать образ $PREVIOUS_TAG"
IMAGE_TAG="$PREVIOUS_TAG" "${COMPOSE[@]}" up -d --remove-orphans ||
  fail "откат: не удалось поднять $PREVIOUS_TAG"

if healthcheck; then
  # `.env` уже содержит новый тег — возвращаем прежний, иначе файл врёт о том, что запущено.
  sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${PREVIOUS_TAG}|" .env || true
  write_marker "$PREVIOUS_TAG"
  fail "деплой $IMAGE_TAG не прошёл healthcheck; откат на $PREVIOUS_TAG выполнен — прод работает"
fi

diagnostics
fail "деплой $IMAGE_TAG не прошёл healthcheck, откат на $PREVIOUS_TAG тоже не поднялся — нужен ручной разбор"
