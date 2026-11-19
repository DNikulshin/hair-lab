#!/usr/bin/env bash
# Автопродление wildcard-сертификата `*.dnikulshin.ru` на хосте (issue #112).
#
# Зачем: на хосте нет ни certbot, ни acme.sh, ни cron — сертификат из `/etc/ssl/dnikulshin/`
# выпускался вручную и истекает 2027-01-30 (проверено `openssl x509 -noout -dates`). Пока
# продление не автоматизировано, смена даты = недоступный HTTPS на всех поддоменах.
#
# Сертификат — wildcard (`SAN: DNS:*.dnikulshin.ru`, без apex), поэтому проверка только
# DNS-01: HTTP-01 для `*.` не годится. Владелец DNS один раз задаёт плагин и ключи провайдера
# в `/etc/hair-lab/cert.env` (образец — `deploy/cert/install.md`); дальше всё делает таймер
# `hair-lab-cert-renew.timer` два раза в сутки.
#
# Режимы:
#   (без аргументов) — продлить, если acme.sh считает, что пора, и переустановить файлы; так
#                      вызывает systemd. Ремонт вместо «тихо сломалось»: перед продлением
#                      делается резервная копия, после — проверка нового сертификата и `nginx -t`,
#                      при ошибке файлы возвращаются на место.
#   --check           — сколько дней осталось; код 1, если меньше MIN_DAYS_LEFT.
#   --dry-run         — показать конфигурацию и запланированные команды, ничего не менять
#                      и не ходить в сеть (так проверяется правка скрипта без root и без LE).
#   --force           — перевыпустить даже если срок ещё не подошёл (для отладки DNS-плагина).
#   --help            — эта справка.
#
# Конфигурация: `CERT_ENV` (по умолчанию `/etc/hair-lab/cert.env`) — `KEY=VALUE`, права `600`.
# Переменные ниже имеют безопасные значения по умолчанию; обязателен только `ACME_DNS_PLUGIN`
# для продления. Логи — в journal (`journalctl -u hair-lab-cert-renew`); ни ключи провайдера,
# ни содержимое ключа сертификата в вывод не попадают.
set -euo pipefail

export PATH="${CERT_PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
export LC_ALL=C

CERT_ENV="${CERT_ENV:-/etc/hair-lab/cert.env}"

# Домен — только wildcard: apex `dnikulshin.ru` этим сертификатом не покрыт и здесь не нужен.
DOMAIN="${CERT_DOMAIN:-*.dnikulshin.ru}"
# Каталог с файлами, которые читает nginx (deploy/nginx/*.conf).
INSTALL_DIR="${CERT_INSTALL_DIR:-/etc/ssl/dnikulshin}"
FULLCHAIN="$INSTALL_DIR/fullchain.pem"
KEYFILE="$INSTALL_DIR/key.pem"
# Домашний каталог acme.sh (`--home`): конфиг аккаунта и записи о сертификате.
ACME_HOME="${ACME_HOME:-/root/.acme.sh}"
# DNS-плагин acme.sh: `dns_cf`, `dns_yandex360`, `dns_regru`, … — задаёт владелец.
ACME_DNS_PLUGIN="${ACME_DNS_PLUGIN:-}"
# Команда перезагрузки nginx после установки файлов.
RELOAD_CMD="${CERT_RELOAD_CMD:-systemctl reload nginx}"
# Порог для `--check`: столько дней должно оставаться, иначе тревога.
MIN_DAYS_LEFT="${CERT_MIN_DAYS_LEFT:-21}"

log() {
  printf 'cert-renew: %s\n' "$*"
}

deny() {
  printf 'cert-renew: отказано: %s\n' "$*" >&2
  exit 64
}

usage() {
  cat <<'EOF'
Автопродление wildcard-сертификата (issue #112).

  renew-cert.sh              продлить, если пора, и переустановить файлы (вызов systemd)
  renew-cert.sh --check      сколько дней осталось; код 1, если меньше CERT_MIN_DAYS_LEFT
  renew-cert.sh --dry-run    показать конфигурацию и план без изменений и без сети
  renew-cert.sh --force      перевыпустить даже раньше срока
  renew-cert.sh --help       эта справка

Конфигурация: /etc/hair-lab/cert.env (или $CERT_ENV); образец — deploy/cert/install.md.
EOF
}

# Конфигурация владельца: файл читаем как есть, но не печатаем (ключи провайдера).
load_config() {
  if [[ -f "$CERT_ENV" ]]; then
    # shellcheck disable=SC1090  # путь задаётся окружением, не литералом
    set -a && . "$CERT_ENV" && set +a
    # Переменные из файла могли переопределить значения выше — пересчитываем производные.
    DOMAIN="${CERT_DOMAIN:-$DOMAIN}"
    INSTALL_DIR="${CERT_INSTALL_DIR:-$INSTALL_DIR}"
    FULLCHAIN="$INSTALL_DIR/fullchain.pem"
    KEYFILE="$INSTALL_DIR/key.pem"
    ACME_HOME="${ACME_HOME:-$ACME_HOME}"
    ACME_DNS_PLUGIN="${ACME_DNS_PLUGIN:-$ACME_DNS_PLUGIN}"
    RELOAD_CMD="${CERT_RELOAD_CMD:-$RELOAD_CMD}"
    MIN_DAYS_LEFT="${CERT_MIN_DAYS_LEFT:-$MIN_DAYS_LEFT}"
  else
    log "нет $CERT_ENV — работаю на значениях по умолчанию (см. deploy/cert/install.md)"
  fi
}

acme_bin() {
  if [[ -x "$ACME_HOME/acme.sh" ]]; then
    printf '%s\n' "$ACME_HOME/acme.sh"
  elif command -v acme.sh >/dev/null 2>&1; then
    command -v acme.sh
  else
    return 1
  fi
}

# Сколько дней осталось у установленного сертификата (пусто — файла нет или он не читается).
days_left() {
  [[ -r "$FULLCHAIN" ]] || return 1
  local not_after
  not_after="$(openssl x509 -in "$FULLCHAIN" -noout -enddate 2>/dev/null | cut -d= -f2)" || return 1
  [[ -n "$not_after" ]] || return 1
  local end_epoch now_epoch
  end_epoch="$(date -d "$not_after" +%s)"
  now_epoch="$(date +%s)"
  printf '%s\n' "$(((end_epoch - now_epoch) / 86400))"
}

check_mode() {
  local left
  if ! left="$(days_left)"; then
    log "сертификат не найден или не читается: $FULLCHAIN"
    return 1
  fi
  log "осталось дней: $left ($FULLCHAIN)"
  if ((left < MIN_DAYS_LEFT)); then
    log "меньше порога $MIN_DAYS_LEFT — нужно продление"
    return 1
  fi
  return 0
}

dry_run() {
  log "режим --dry-run: ничего не меняю"
  log "конфигурация: $CERT_ENV"
  log "домен: $DOMAIN"
  log "каталог установки: $INSTALL_DIR"
  log "acme.sh: $(acme_bin || printf 'не найден')"
  log "DNS-плагин: ${ACME_DNS_PLUGIN:-не задан}"
  log "перезагрузка: $RELOAD_CMD"
  log "порог дней: $MIN_DAYS_LEFT"
  if left="$(days_left)"; then
    log "текущий сертификат: осталось дней $left"
  else
    log "текущий сертификат: не найден"
  fi
  log "запланировано: acme.sh --cron --home $ACME_HOME, проверка сертификата, nginx -t, $RELOAD_CMD"
  if [[ -z "$ACME_DNS_PLUGIN" ]]; then
    log "внимание: ACME_DNS_PLUGIN не задан — продление в реальном режиме откажется работать"
  fi
  return 0
}

# Резервная копия установленных файлов: при ошибке возвращаем их на место.
backup_current() {
  [[ -r "$FULLCHAIN" && -r "$KEYFILE" ]] || return 0
  PREV_DIR="$(mktemp -d)"
  install -m 600 "$FULLCHAIN" "$PREV_DIR/fullchain.pem"
  install -m 600 "$KEYFILE" "$PREV_DIR/key.pem"
  log "резервная копия: $PREV_DIR"
}

restore_current() {
  [[ -n "${PREV_DIR:-}" && -r "$PREV_DIR/fullchain.pem" && -r "$PREV_DIR/key.pem" ]] || return 0
  install -m 644 "$PREV_DIR/fullchain.pem" "$FULLCHAIN"
  install -m 600 "$PREV_DIR/key.pem" "$KEYFILE"
  log "файлы возвращены из $PREV_DIR"
  # shellcheck disable=SC2086  # команда задана конфигом владельца (без кавычек, как в acme.sh)
  $RELOAD_CMD || log "перезагрузка после откката не удалась — проверьте nginx руками"
}

# Проверка нового сертификата: файл читается, срок не истёк, nginx принимает конфиг.
verify_installed() {
  if ! openssl x509 -in "$FULLCHAIN" -noout -checkend 0 >/dev/null 2>&1; then
    log "новый сертификат не читается или уже истёк: $FULLCHAIN"
    return 1
  fi
  local left
  left="$(days_left)"
  log "установлен сертификат, дней до истечения: $left"
  if command -v nginx >/dev/null 2>&1 && ! nginx -t >/dev/null 2>&1; then
    log "nginx -t не прошёл с новыми файлами"
    return 1
  fi
  return 0
}

renew() {
  [[ $EUID -eq 0 ]] || deny "продление требует root (files в $INSTALL_DIR и systemctl reload nginx)"
  local acme
  acme="$(acme_bin)" || deny "acme.sh не найден: установите его по deploy/cert/install.md"
  [[ -n "$ACME_DNS_PLUGIN" ]] || deny "не задан ACME_DNS_PLUGIN в $CERT_ENV (DNS-01 для wildcard обязателен)"

  local dir
  dir="$(dirname "$FULLCHAIN")"
  [[ -d "$dir" ]] || deny "нет каталога $dir — создайте его по deploy/cert/install.md"

  backup_current

  local args=(--cron --home "$ACME_HOME")
  if [[ "${FORCE:-0}" == "1" ]]; then
    args+=(--force)
    log "режим --force: перевыпуск независимо от срока"
  fi
  log "запуск: $acme ${args[*]}"
  if ! "$acme" "${args[@]}"; then
    log "acme.sh завершился с ошибкой — файлы не менялись"
    return 1
  fi

  # Переустановка файлов: у acme.sh уже сохранены пути из `--install-cert`, но повторяем явно,
  # чтобы путь к сертификату не зависел от состояния его конфигурации.
  if ! "$acme" --install-cert -d "$DOMAIN" --home "$ACME_HOME" \
    --key-file "$KEYFILE" \
    --fullchain-file "$FULLCHAIN" \
    --reloadcmd "$RELOAD_CMD"; then
    log "--install-cert завершился с ошибкой"
    restore_current
    return 1
  fi

  if ! verify_installed; then
    restore_current
    return 1
  fi

  log "готово: сертификат обновлён и установлен в $INSTALL_DIR"
}

main() {
  case "${1:-}" in
    --help | -h)
      usage
      return 0
      ;;
    --check)
      load_config
      check_mode
      return $?
      ;;
    --dry-run)
      load_config
      dry_run
      return 0
      ;;
    --force)
      FORCE=1
      ;;
    '')
      ;;
    *)
      deny "неизвестный аргумент: $1 (допустимы --check, --dry-run, --force, --help)"
      ;;
  esac

  load_config
  renew
}

main "$@"
