# Разовая настройка автопродления wildcard-сертификата (`*.dnikulshin.ru`)

Issue: #112. Контекст: `docs/deploy.md` §6 (nginx и TLS).

## Зачем

На хосте нет ни `certbot`, ни `acme.sh`, ни cron: сертификат в `/etc/ssl/dnikulshin/`
выпускался вручную, и как — не зафиксировано. Факты с хоста (`openssl x509 -noout -subject
-dates -ext subjectAltName`):

| Что           | Значение                                                     |
| ------------- | ------------------------------------------------------------ |
| Subject / SAN | `CN=*.dnikulshin.ru`, `DNS:*.dnikulshin.ru` (apex не покрыт) |
| Выпущен       | 2026-11-01 09:20 UTC                                         |
| Истекает      | **2027-01-30 09:20 UTC**                                     |
| Издатель      | Let's Encrypt `YE2`                                          |

Wildcard покрывает только поддомены, поэтому единственный способ продления — **DNS-01**
(HTTP-01 для `*.` невозможен). Значит, нужен доступ к API DNS-провайдера домена.

Автоматизация в репозитории:

| Файл                                      | Роль                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `deploy/cert/renew-cert.sh`               | продление через `acme.sh --cron`, установка файлов, проверка результата, откат при ошибке, режимы `--check`/`--dry-run` |
| `deploy/cert/hair-lab-cert-renew.service` | oneshot-запуск скрипта от root                                                                                          |
| `deploy/cert/hair-lab-cert-renew.timer`   | два раза в сутки (03:17 и 15:17 UTC, разброс до часа) + `Persistent=true`                                               |

**Агенту этот шаг выполнить нельзя** (нет root, нет ключей DNS-провайдера), поэтому порядок
ниже — для владельца с `sudo`. Пока шаг не выполнен, автопродления нет: после 2027-01-30
HTTPS на всех поддоменах перестанет работать.

## 1. Поставить `acme.sh` (root)

```bash
# Вариант без git: официальный установщик кладёт acme.sh в ~/.acme.sh и создаёт symlink в PATH.
curl -sS https://get.acme.sh | sudo sh -s email=no-reply@dnikulshin.ru

# Проверка
sudo /root/.acme.sh/acme.sh --version
```

`acme.sh` при установке заводит **свой cron**. С systemd-таймером он не нужен (двойное
продление — лишние запросы к Let's Encrypt), поэтому его надо убрать:

```bash
sudo crontab -l | grep -v acme.sh | sudo crontab -   # убрать только строку acme.sh
sudo crontab -l                                      # проверить, что осталось
```

Однократно выбираем CA (по умолчанию может оказаться ZeroSSL):

```bash
sudo /root/.acme.sh/acme.sh --set-default-ca --server letsencrypt
```

## 2. Доступ к DNS домена

Плагин `acme.sh` соответствует провайдеру, у которого лежит зона `dnikulshin.ru`. Полный
список — `sudo /root/.acme.sh/acme.sh --help | grep -i dns_` (их больше сотни). Частые
варианты:

| Где зона                      | Плагин                         | Переменные окружения                                                 |
| ----------------------------- | ------------------------------ | -------------------------------------------------------------------- |
| Cloudflare                    | `dns_cf`                       | `CF_Token`, `CF_Account_ID` (при нескольких зонах)                   |
| Яндекс 360 / Yandex Cloud DNS | `dns_yandex360` / `dns_yandex` | `YANDEX360_Client_ID`, `YANDEX360_Client_Secret`, `YANDEX360_Org_ID` |
| reg.ru                        | `dns_regru`                    | `REG_RU_Username`, `REG_RU_Password`                                 |
| VK Cloud / Selectel           | `dns_vkcloud` / `dns_selectel` | по документации плагина                                              |

**Ключи выпускаются как можно уже:** токен только на правку DNS-записей этой зоны, без
доступа к аккаунту и биллингу. Значения переменных перечисляет `--help` конкретного плагина:
`acme.sh --help dns_cf`.

## 3. Конфигурация на хосте

```bash
sudo install -d -m 755 /etc/hair-lab
sudo install -m 600 /dev/null /etc/hair-lab/cert.env
sudo nano /etc/hair-lab/cert.env
```

`/etc/hair-lab/cert.env` (права `600`, владелец root) — образец:

```bash
# Домен — только wildcard: apex dnikulshin.ru этим сертификатом не покрыт.
CERT_DOMAIN=*.dnikulshin.ru
CERT_INSTALL_DIR=/etc/ssl/dnikulshin
ACME_HOME=/root/.acme.sh
# Плагин DNS-01 выбранного провайдера:
ACME_DNS_PLUGIN=dns_cf

# Ключи провайдера — те имена, которые ждёт выбранный плагин (пример Cloudflare):
CF_Token=...
CF_Account_ID=...

# Порог для режима --check: столько дней должно остаться, иначе код 1 (тревога).
CERT_MIN_DAYS_LEFT=21
```

Файл читается скриптом как обычный `VARIABLE=VALUE`; в репозиторий он не попадает и в логи
не печатается.

## 4. Первый выпуск (проверка плагина на staging-CA)

```bash
# 1. Пробный выпуск у staging-окружения Let's Encrypt: ошибки плагина видны сразу,
#    боевые лимиты (5 неудач/час, 5 дублей/неделю) не расходуются.
sudo env \
  CF_Token='...' CF_Account_ID='...' \
  /root/.acme.sh/acme.sh --issue --dns dns_cf \
    -d '*.dnikulshin.ru' --keylength 2048 --staging

# 2. Боевой выпуск (после успешного шага 1)
sudo env \
  CF_Token='...' CF_Account_ID='...' \
  /root/.acme.sh/acme.sh --issue --dns dns_cf \
    -d '*.dnikulshin.ru' --keylength 2048

# 3. Установка файлов туда, откуда их читает nginx, с перезагрузкой nginx
sudo /root/.acme.sh/acme.sh --install-cert -d '*.dnikulshin.ru' \
  --key-file       /etc/ssl/dnikulshin/key.pem \
  --fullchain-file /etc/ssl/dnikulshin/fullchain.pem \
  --reloadcmd      'systemctl reload nginx'
```

Ожидаемо: `fullchain.pem` — `644` и содержит цепочку (лист + промежуточный), `key.pem` — `600`,
`nginx -t` проходит, `systemd reload nginx` без ошибок. Пути совпадают с
`deploy/nginx/hair-lab.staging.dnikulshin.ru.conf`, править конфиг nginx не нужно.

## 5. Поставить скрипт и таймер

```bash
cd /path/to/hair-lab   # деплой-клон или рабочая копия на хосте
sudo install -m 755 deploy/cert/renew-cert.sh                /usr/local/sbin/hair-lab-cert-renew
sudo install -m 644 deploy/cert/hair-lab-cert-renew.service  /etc/systemd/system/
sudo install -m 644 deploy/cert/hair-lab-cert-renew.timer    /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hair-lab-cert-renew.timer
```

## 6. Проверить

```bash
# 1. Конфигурация читается, acme.sh виден, срок правильный
sudo /usr/local/sbin/hair-lab-cert-renew --dry-run
sudo /usr/local/sbin/hair-lab-cert-renew --check && echo "срок в норме"

# 2. Таймер запланирован
systemctl list-timers hair-lab-cert-renew.timer

# 3. Ручной прогон сервиса: продления не будет (срок не подошёл), но видно, что acme.sh
#    запускается и файлы проверяются
sudo systemctl start hair-lab-cert-renew.service
journalctl -u hair-lab-cert-renew -n 40 --no-pager
```

Что должно быть в журнале: `запуск: /root/.acme.sh/acme.sh --cron …`, затем строка `acme.sh`
о пропуске продления (`Skipping … next renew after …`) или о выпуске, затем
`установлен сертификат, дней до истечения: <n>` и `готово`.

**Проверка настоящего продления** (не раньше 60 дней до истечения — иначе Let's Encrypt
посчитает выпуск дублем):

```bash
sudo /usr/local/sbin/hair-lab-cert-renew --force
sudo /usr/local/sbin/hair-lab-cert-renew --check
openssl x509 -in /etc/ssl/dnikulshin/fullchain.pem -noout -dates
```

## 7. Если что-то пошло не так

- Скрипт перед продлением делает резервную копию `fullchain.pem`/`key.pem` в `mktemp -d`
  и при ошибке (`acme.sh`, `--install-cert`, битый сертификат, `nginx -t`) возвращает файлы
  на место и печатает путь к копии в журнале. Ручной откат — тем же путём: `install -m 644`
  для `fullchain.pem`, `install -m 600` для `key.pem`, затем `systemctl reload nginx`.
- `cert-renew: отказано: не задан ACME_DNS_PLUGIN` — конфигурация не прочитана или в ней
  нет плагина: проверьте `/etc/hair-lab/cert.env` и права (`600`, root).
- Ошибки плагина DNS видны в выводе `acme.sh --issue … --debug 2`; на staging-CA
  (`--staging`) их можно повторять без боевых лимитов.
- Тревога заранее: `--check` возвращает код 1, когда осталось меньше `CERT_MIN_DAYS_LEFT`
  дней. Удобно повесить в любой внешний мониторинг.

## 8. Что осталось владельцу

- [ ] DNS-провайдер зоны `dnikulshin.ru` и токен с правом правки DNS-записей (шаг 2).
- [ ] `acme.sh` установлен, свой cron выключен, CA — Let's Encrypt (шаг 1).
- [ ] `/etc/hair-lab/cert.env` создан с правами `600` (шаг 3).
- [ ] Сертификат выпущен и установлен, `nginx -t` зелёный (шаг 4).
- [ ] Скрипт и таймер установлены, `systemctl list-timers` показывает расписание (шаг 5).
- [ ] Проверки шага 6 пройдены, журнал содержит строку `готово`.

Пока эти пункты не закрыты, автопродление **не проверено** (issue #112 остаётся открытым):
скрипт и юниты в репозитории, но на хосте их нет.
