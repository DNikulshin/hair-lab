#!/usr/bin/env bash
# Принудительная команда для ключа GitHub Actions (issue #128).
#
# sshd запускает её вместо любой команды клиента: в `authorized_keys` строка выглядит как
#   restrict,command="/home/deployer/hair-lab-staging/ssh-deploy.sh" ssh-ed25519 AAAA…
# Кавычки вокруг значения `command=` обязательны: без них sshd молча игнорирует ключ
# (проверено на OpenSSH 10.2 — `command=/path` даёт `Permission denied`, issue #132).
# Клиентская команда попадает в SSH_ORIGINAL_COMMAND, и разрешены ровно две формы:
#   deploy <ref>        — staging: сборка на хосте (issue #125)
#   deploy-image <ref>  — preprod: образы из GHCR, как на проде (issue #139)
# Так ключ из секрета репозитория не даёт ни шелла, ни доступа к docker: максимум — деплой
# коммита из истории `main` в один из двух контуров.
#
# Почему не from="…": GitHub публикует 8350 диапазонов адресов Actions (151 КБ в одной строке),
# а при их смене деплой молча ломался бы на `Permission denied`.
#
# Скрипт установлен в каталоге стека и обновляется вручную (`scp` этим ключом запрещён).
# Сам deploy-скрипт всегда берётся из `origin/main` деплой-клона, поэтому обновляется сам.
set -euo pipefail

# У sshd минимальный PATH без /snap/bin, где на этом хосте живёт snap-docker.
export PATH="${STAGING_PATH:-/snap/bin:/usr/local/bin:/usr/bin:/bin}"
export LC_ALL=C

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="${STAGING_DEPLOY_DIR:-$HOME/hair-lab-deploy}"

deny() {
  echo "отказано: $*" >&2
  exit 64
}

cmd="${SSH_ORIGINAL_COMMAND:-}"
case "$cmd" in
  deploy\ *)
    ref="${cmd#deploy }"
    runner="scripts/deploy-staging.sh"
    ;;
  deploy-image\ *)
    ref="${cmd#deploy-image }"
    runner="scripts/deploy-preprod.sh"
    ;;
  *)
    deny "разрешены команды «deploy <ref>» и «deploy-image <ref>», получено: «${cmd}»"
    ;;
esac

# main или коммит из истории main. Никаких флагов, кавычек и составных команд.
[[ "$ref" =~ ^(main|[0-9a-f]{7,40})$ ]] ||
  deny "ref должен быть main или sha (7..40 hex), получено: «${ref}»"

[[ -d "$DEPLOY_DIR/.git" ]] || deny "нет деплой-клона $DEPLOY_DIR"

# Свежие ссылки: deploy-скрипт берём из origin/main, а не из рабочего каталога клона — тот мог
# остаться на любом коммите, а bash нельзя подменять файл, который он в этот момент читает.
git -C "$DEPLOY_DIR" fetch --prune --force origin '+refs/heads/*:refs/remotes/origin/*' >/dev/null

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
git -C "$DEPLOY_DIR" show "origin/main:$runner" >"$tmp"

STAGING_STACK_DIR="$STACK_DIR" STAGING_DEPLOY_DIR="$DEPLOY_DIR" bash "$tmp" "$ref"
