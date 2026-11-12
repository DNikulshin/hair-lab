#!/usr/bin/env bash
# Настройка GitHub-процесса проекта: метки, вехи, бэклог, правила ветки main.
#
# Идемпотентен: метки обновляются (--force), issues не дублируются по заголовку.
# Требуется авторизованный `gh` с правами admin на репозиторий.
#
#   ./scripts/gh-setup.sh              метки + вехи + issues
#   ./scripts/gh-setup.sh --protect    дополнительно правила ветки main (нужна существующая main)
#
# Переменные: REPO (по умолчанию DNikulshin/hair-lab).
set -euo pipefail

REPO="${REPO:-DNikulshin/hair-lab}"

label() {
  gh label create "$1" --repo "$REPO" --color "$2" --description "$3" --force
}

milestone() {
  local title="$1"
  if gh api "repos/$REPO/milestones" --jq '.[].title' | grep -qxF "$title"; then
    echo "  веха уже есть: $title"
  else
    gh api "repos/$REPO/milestones" -f title="$title" --jq '"  веха создана: " + .title'
  fi
}

create_issue() {
  local title="$1" labels="$2" milestone="$3"
  local body existing
  body=$(cat)
  existing=$(gh issue list --repo "$REPO" --state all --search "$title in:title" --json number \
    --jq '.[0].number // empty')
  if [[ -n "$existing" ]]; then
    echo "  issue уже есть: #$existing $title"
    return
  fi
  gh issue create --repo "$REPO" --title "$title" --body "$body" --label "$labels" \
    ${milestone:+--milestone "$milestone"} | tail -n 1
}

protect_main() {
  echo "→ правила ветки main"
  gh api -X PUT "repos/$REPO/branches/main/protection" --input - <<'JSON' >/dev/null
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "checks",
      "docker (api, apps/api/Dockerfile)",
      "docker (web, apps/web/Dockerfile)"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
  echo "  main: PR обязателен, force-push и удаление запрещены, нужны зелёные checks"
}

echo "→ метки"
while IFS='|' read -r name color description; do
  [[ -z "$name" ]] && continue
  label "$name" "$color" "$description"
done <<'LABELS'
type:feature|1f883d|Новая функциональность
type:bug|d73a4a|Ошибка или регрессия
type:chore|6e7781|Инфраструктура, зависимости, рефакторинг
type:spike|8250df|Исследование: нужно решение до кода
area:api|0969da|apps/api
area:web|1a7f37|apps/web
area:contracts|8250df|packages/contracts
area:data|bf8700|Схема БД и миграции
area:infra|c5def5|CI, Docker, деплой
area:design|db61a2|Визуальный язык и UI
status:todo|ededed|Бэклог, можно брать в работу
status:in-progress|fbca04|В работе
status:review|0e8a16|Ждёт проверки владельца
status:blocked|b60205|Заблокировано
prio:p1|b60205|Блокирует MVP
prio:p2|fbca04|Нужно к релизу
prio:p3|c2e0c6|Можно позже
size:s|d4c5f9|До полудня работы
size:m|d4c5f9|Один-два дня
size:l|d4c5f9|Больше двух дней: дробить
needs-owner|5319e7|Нужно решение владельца
LABELS

echo "→ вехи"
milestone "MVP: каталог и запись"
milestone "MVP: оплата и уведомления"
milestone "Инфраструктура и релиз"
milestone "После MVP"

echo "→ бэклог"
create_issue "Схема БД: услуги, мастера, расписание, записи" \
  "type:feature,area:data,area:api,prio:p1,size:l" "MVP: каталог и запись" <<'BODY'
Первая схема PostgreSQL (Prisma) под каталог и запись. Делается через `/cycle`.

Входит:
- модели: услуга (категория, длительность, цена в копейках), мастер, рабочее расписание и исключения;
- слот: уникальность на уровне БД, время в UTC, часовой пояс салона в конфиге;
- запись: идемпотентность по ключу, связь клиента (или гостя) со слотом;
- миграции expand/contract, обратный откат описан в PR.

Не входит: оплата, уведомления, абонементы.
BODY

create_issue "Контракты каталога: услуги, категории, мастера" \
  "type:feature,area:contracts,prio:p1,size:m" "MVP: каталог и запись" <<'BODY'
Zod-схемы публичного каталога и их использование в API.

- `GET /services` (категории + услуги, цена в копейках, длительность)
- `GET /masters` (публичный профиль: имя, квалификация, услуги)
- пагинация и ошибки — из `common/*`
- изменения только обратно совместимые
BODY

create_issue "Витрина услуг и мастеров на сайте" \
  "type:feature,area:web,prio:p1,size:m" "MVP: каталог и запись" <<'BODY'
Публичные страницы каталога: статика/ISR, без персональных данных.

- список категорий и услуг с ценами и длительностью
- карточки мастеров
- связка с API через `NEXT_PUBLIC_API_URL`, ошибки сети не ломают страницу
BODY

create_issue "API: слоты и создание записи (уникальность и идемпотентность)" \
  "type:feature,area:api,area:data,prio:p1,size:l" "MVP: каталог и запись" <<'BODY'
Ядро записи.

- `GET /slots` по услуге, мастеру и дате
- `POST /bookings` с idempotency key
- двойное бронирование невозможно (unique/exclusion constraint в БД)
- занятый слот → `slot_unavailable`, повтор с тем же ключом → та же запись
- тест на гонку (два параллельных запроса)
BODY

create_issue "Гостевая запись без регистрации" \
  "type:feature,area:web,area:api,prio:p1,size:m" "MVP: каталог и запись" <<'BODY'
Клиент записывается без аккаунта: имя + телефон, подтверждение на email.

- валидация телефона на границе (Zod)
- телефон не логируется, в ответах маскируется
- после записи предлагается создать аккаунт для кабинета
BODY

create_issue "Авторизация: email + пароль и вход по ссылке" \
  "type:feature,area:api,area:web,prio:p1,size:l" "MVP: каталог и запись" <<'BODY'
Вход клиента в кабинет.

- регистрация по email + пароль (хеш argon2id)
- вход по одноразовой ссылке на email
- сессия в httpOnly cookie, CSRF-защита
- клиент видит только свои записи (проверка владельца до чтения)
BODY

create_issue "Кабинет клиента: мои записи" \
  "type:feature,area:web,area:api,prio:p2,size:m" "MVP: каталог и запись" <<'BODY'
Личный кабинет: список предстоящих и прошлых записей, отмена по правилам салона.
BODY

create_issue "ЮKassa: оплата записи и вебхук" \
  "type:feature,area:api,prio:p1,size:l" "MVP: оплата и уведомления" <<'BODY'
Полная оплата записи через ЮKassa (тестовый магазин на этапе разработки).

- создание платежа, возврат на сайт, страница статуса
- вебхук с проверкой подписи/IP, идемпотентная обработка
- запись подтверждается только после успешной оплаты, истёкшая оплата освобождает слот
- секреты только в окружении, в тестах — моки
BODY

create_issue "Email-уведомления: outbox и SMTP" \
  "type:feature,area:api,area:infra,prio:p1,size:m" "MVP: оплата и уведомления" <<'BODY'
Письма клиенту и салону вне транзакции записи.

- таблица outbox, воркер с ретраями
- SMTP Яндекса или Google (уточняется), секреты в окружении
- сбой провайдера не ломает создание записи
- ссылки входа и подтверждения записи
BODY

create_issue "Абонементы" \
  "type:feature,area:api,area:web,prio:p2,size:l" "MVP: каталог и запись" <<'BODY'
Пакеты посещений: покупка, списание при записи, остаток в кабинете.
BODY

create_issue "Отзывы клиентов" \
  "type:feature,area:api,area:web,prio:p3,size:m" "После MVP" <<'BODY'
Отзывы после визита, модерация, публичный список на сайте.
BODY

create_issue "Галерея работ" \
  "type:feature,area:api,area:web,area:design,prio:p3,size:m" "После MVP" <<'BODY'
Галерея работ мастеров: загрузка изображений, оптимизация, публичная лента.
BODY

create_issue "Дизайн-направление и UI-кит" \
  "type:feature,area:design,prio:p1,size:l,needs-owner" "MVP: каталог и запись" <<'BODY'
Уникальная стилистика салона вместо референса.

- 2–3 направления на выбор владельца
- токены (цвет, типографика, ритм) в `globals.css`
- базовые компоненты: кнопка, поле, карточка, секция
- проверка контраста и клавиатурной навигации
BODY

create_issue "nginx и TLS на VPS" \
  "type:chore,area:infra,prio:p1,size:m" "Инфраструктура и релиз" <<'BODY'
nginx на хосте проксирует web и /api на контейнеры (порты опубликованы только на 127.0.0.1).

- конфиг в `deploy/nginx/`, сертификаты (certbot или уже имеющиеся)
- заголовки безопасности, gzip/brotli, кэш статики
- проверка: сайт по https, `/api/health` отвечает
BODY

create_issue "Миграции БД в пайплайне" \
  "type:chore,area:infra,area:data,prio:p2,size:s" "Инфраструктура и релиз" <<'BODY'
Перед `up -d` на VPS выполнять `prisma migrate deploy` отдельным шагом.
Нужно после появления схемы БД; откат и запрет деструктивных операций — в описании шага.
BODY

create_issue "PWA: manifest, service worker, офлайн" \
  "type:feature,area:web,prio:p2,size:m" "MVP: каталог и запись" <<'BODY'
Установка на телефон, офлайн-оболочка.

- `manifest` с иконками из бренда
- service worker не кэширует ответы API с персональными данными
- офлайн-страница и стратегия для статики
BODY

create_issue "Bootstrap репозитория и защита main" \
  "type:chore,area:infra,prio:p1,size:s" "Инфраструктура и релиз" <<'BODY'
Первый коммит каркаса, ветка main, правила ветки, метки и вехи.

- [x] метки, вехи, бэклог
- [ ] первый коммит в main (bootstrap пустого репозитория)
- [ ] protection: PR обязателен, нужны зелёные checks
- [ ] проверка: PR из рабочей ветки проходит CI
BODY

echo "→ настройки репозитория"
gh api -X PATCH "repos/$REPO" \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=COMMIT_MESSAGES \
  --jq '"  squash-merge включён, лишние ветки удаляются: " + (.deleteBranchOnMerge|tostring)'

if [[ "${1:-}" == "--protect" ]]; then
  protect_main
else
  echo "→ пропущено: правила main (запустите с --protect, когда main существует)"
fi

echo "Готово: https://github.com/$REPO/issues"
