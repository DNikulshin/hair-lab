# Проверки web в браузере

Быстрые воспроизводимые сценарии для правок `apps/web`. Выполняет супервизор через MCP
`playwright` (у субагентов `code`/`review` MCP-инструментов нет — они закрывают только чтение кода
и терминал). Смысл: то, что видно только в браузере (service worker, кэш, куки, гидратация,
реальные заголовки), нельзя закрыть юнит-тестами.

## Общие правила

### Сборка и запуск (production, порт 3003)

`next start` **не работает** с `output: 'standalone'` (`apps/web/next.config.ts`): сервер печатает
предупреждение и отдаёт 404 на всех маршрутах. Запускаем standalone-сервер:

```bash
# 1. Переменные прокси-префиксов очищаем: иначе Next вшивает /absproxy/<port> в сборку
#    и все страницы отвечают 404 (в dev-окружении code-server эти переменные бывают заданы).
NEXT_BASE_PATH= NEXT_ASSET_PREFIX= pnpm --filter @hair-lab/web build

# 2. standalone-вывод не содержит статики — докладываем её рядом.
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
cp -r apps/web/public  apps/web/.next/standalone/apps/web/public

# 3. Запуск (порт 3000 занят pc-remote, 3001 — api, 3002 — dev web).
cd apps/web/.next/standalone/apps/web
PORT=3003 HOSTNAME=127.0.0.1 NEXT_PUBLIC_API_URL=http://127.0.0.1:3001 node server.js
```

Данные витрины приходят с api — без него страницы отдают fallback «временно недоступен»:

```bash
DATABASE_URL='postgresql://hair_lab:change_me@127.0.0.1:55432/hair_lab' \
  PAYMENTS_MODE=off APP_URL='http://localhost:3003' CORS_ORIGINS='http://localhost:3003' \
  pnpm --filter @hair-lab/api dev
```

После проверки гасим оба процесса (по порту, не по имени — `pkill -f 'next start'` не сработает):

```bash
for p in 3003 3001; do kill "$(ss -tlnpH "sport = :$p" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)"; done
```

### Что смотреть и как показывать результат

- Всегда смотрим **консоль** и **сеть**: 4xx/5xx на своих же ассетах — баг, даже если страница
  «выглядит нормально». В chrome-devtools это `list_console_messages` / `list_network_requests`,
  в playwright — `browser_console_messages` / `browser_network_requests`.
- Проверяем светлую и тёмную тему (`emulate` → `colorScheme` / `browser_emulate_media`), если
  правка про UI.
- **Скриншоты владельцу — картинкой в чат**: `chrome-devtools` MCP `take_screenshot` **без
  `filePath`** возвращает image-content, и Pi Web рисует его в транскрипте (вложения `read` так
  не отображаются). С `filePath` тот же тул пишет PNG на диск и в чат ничего не отправляет.
- Для этой же цели есть `publish_preview` / `/share` (см. скилл `design-preview`) — ссылка
  `https://pi.dnikulshin.ru:8443/preview/<slug>/` для другого устройства.
- Если MCP недоступен — в отчёте пишем «браузерная проверка не выполнена» с причиной,
  а не «проверено».

## Сырые данные `qa-web.json`

Результат браузерной проверки супервизор записывает в `qa-web.json` каталога цикла
(`.pi/artifacts/<дата>-<номер>-<slug>/`). Это машинночитаемый вход цикла: `cycle-decide`
считает его доказательством проверки, а оценщик ссылается на шаги как `qa:<id>`.

```json
{
  "status": "done",
  "reason": null,
  "steps": [
    {
      "id": "s1",
      "url": "http://127.0.0.1:3003/booking",
      "action": "открыл страницу, выбрал услугу, нажал «Записаться»",
      "observed": "карточка слота появилась, запрос POST /bookings — 201",
      "console_errors": [],
      "failed_requests": [],
      "cache_headers": null
    }
  ]
}
```

Правила:

- `status` — `done` или `not_run`; при `not_run` обязателен `reason` (например «MCP
  `playwright` недоступен»), список шагов может быть пустым;
- `id` шагов — `s1`, `s2`, … (тот же шаблон, что в `refs.mjs`); нумерация сквозная,
  без пропусков;
- `url` — абсолютный адрес стенда или `http://127.0.0.1:3003/...`; `action` — что именно
  нажимали/вводили; `observed` — фактический результат, а не ожидание;
- `console_errors` и `failed_requests` — только реальные ошибки своих страниц/ассетов
  (пустой массив — «чисто»); `cache_headers` — `null`, если правка не про кэш/PWA;
- **ПДн и секреты не записываем**: ни телефонов, ни e-mail, ни токенов, ни `Set-Cookie`.
  Скриншоты — по правилам выше, без авторизованных личных данных.
- Ошибки в файле (неизвестный `status`, шаг без `id`) — дефект артефакта: `refs.mjs`
  не разрешит такие ссылки, а оценщик отметит шаг как непроверенный.

## Сценарий: PWA (#16)

Сервер: production-сборка на 3003.

1. Открыть `/`, дождаться `navigator.serviceWorker.ready`.
2. Регистрация: `navigator.serviceWorker.getRegistrations()` → один SW, `scope=/`, `state=activated`.
3. Manifest: `<link rel="manifest">` в HTML; `fetch('/manifest.webmanifest')` → `start_url`, `scope`,
   `display: standalone`, иконки `any` ×2 и `maskable`.
4. Метаданные: `theme-color` (светлая/тёмная), `mobile-web-app-capable`, `apple-mobile-web-app-title`.
5. Precache: `caches.keys()` → только `hair-lab-precache-vN` и `hair-lab-runtime-vN`;
   в precache ровно `/offline` и иконки, **никакого HTML**.
6. Приватные данные: выполнить запрос к `/api/...` и убедиться, что в Cache Storage нет ни одного
   пути `/api`; во всех ответах API и приватных страниц `Cache-Control` содержит `no-store`.
7. Офлайн: `page.context().setOffline(true)` → перейти на `/account`, `/services`,
   `/login/magic?token=…`, `/booking/payment` — везде офлайн-страница «Нет подключения» (status 200 от SW).
   Приватный HTML не должен отдаваться из кэша.
8. Cache-first: найти закэшированный `/_next/static/...` и открыть его офлайн — 200.
9. Вернуть сеть: `setOffline(false)`.

## Сценарий: авторизация (#35, #7)

Нужен живой api и dev-БД. В dev SMTP выключен, письма остаются в `outbox_messages`.

1. `/register` → новый адрес → экран «Проверьте почту» (текст про «аккаунт создан»).
2. `/register` повторно с тем же адресом → ошибка `409`, экран «Проверьте почту» не появляется.
3. `/login` → «Отправить ссылку» → нейтральное сообщение.
4. Погасить ссылку: взять `token_hash` из `login_tokens` нельзя (там хэш), поэтому удобнее вставить
   токен напрямую (см. `apps/api/test/db/helpers.ts`) или пройти через api с известным токеном;
   после погашения — cookie `hl_session` (HttpOnly) и редирект в кабинет.
5. `/account` без сессии → редирект на `/login`; с сессией — список своих записей.
6. Проверить, что в HTML `/account` нет персональных данных (они приходят после клиентского фетча).

## Сценарий: запись (#5)

1. `/book?serviceId=…` → визард: выбор даты/времени, форма.
2. Неверный телефон → ошибка у поля, введённое значение не повторяется в тексте ошибки.
3. Успешная запись → подтверждение; повторная отправка формы не создаёт дубль (idempotency).
4. Слот занят другим клиентом → понятное сообщение `slot_unavailable`, форма не теряет данные.

## Сценарий: оплата записи (#91)

Нужны живой api и dev-БД; режим задаёт `PAYMENTS_MODE` (`off` по умолчанию, `test` — песочница).

1. `PAYMENTS_MODE=off`: `/book` → успешная запись → прежний экран «Запись создана», редиректа на
   страницу оплаты нет.
2. `/booking/payment` без `appointmentId` и без черновика вкладки → «Оплата не найдена», консоль чистая.
3. `/booking/payment?appointmentId=<чужой uuid>` → «Оплата не найдена» (прокси отдаёт 404, не 5xx).
4. `PAYMENTS_MODE=test`: запись → редирект на `/booking/payment?appointmentId=…`, заголовок
   «Ожидаем оплату», таймер около 15:00, «Перейти к оплате» ведёт на страницу провайдера.
5. Заголовки и ПДн: `GET /api/bookings/<id>/payment` → 200 и `Cache-Control: no-store`; HTML страницы
   тоже `no-store`; в URL и `sessionStorage` только uuid записи, ссылка провайдера и ISO-срок —
   телефона, почты и имени нет нигде.
6. Оплата в песочнице → в течение ~5 с экран сам переходит в «Оплачено», без перезагрузки.
7. `/account`, запись со статусом `pending`, вкладка **с черновиком** этой записи (пришли из визарда
   записи) → «Запись ещё не подтверждена.» и ссылка «Перейти к оплате» на
   `/booking/payment?appointmentId=…`.
8. Та же запись **без черновика** (`sessionStorage.clear()` в новой вкладке или `PAYMENTS_MODE=off`) →
   «Запись ещё не подтверждена. Ссылка на оплату — в той вкладке, где вы записывались (если оплата
   включена).», ссылки «Перейти к оплате» нет.
9. SW: `caches.keys()` → `hair-lab-precache-v2` и `hair-lab-runtime-v2`; офлайн-переход на
   `/booking/payment` → офлайн-страница «Нет подключения»; в Cache Storage нет ни `/booking/payment`,
   ни `/api`.
10. Консоль и сеть чистые, светлая и тёмная тема, мобильный вид.

## Что считается неудачей

- Любая ошибка в консоли на своих страницах/ассетах.
- Ответ 5xx на собственных запросах.
- Персональные данные в URL, в HTML до авторизации или в кэше.
- Офлайн-режим показывает чужой/приватный контент вместо офлайн-страницы.
