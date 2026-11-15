---
name: design-preview
description: Быстрый цикл макетов и визуальной оценки для hair-lab — HTML-прототипы в .pi/artifacts, self-hosted шрифты, скриншоты десктоп/мобайл через playwright MCP, проверки контраста и тап-таргетов, публикация ссылки для владельца через publish_preview. Использовать, когда задача про дизайн, вёрстку, UI-кит или нужно показать экраны человеку.
---

# Макеты и визуальная оценка (hair-lab)

Подробности «почему так», устройство канала со ссылкой и обслуживание — `docs/preview.md`.

Владелец смотрит результат с телефона в Pi Web. `127.0.0.1` для него недоступен, ad-hoc порт
закрыт `ufw` (`DEFAULT_INPUT_POLICY=DROP`), `/home/dev` и `~/.pi` закрыты для `www-data` (750/700),
сеть машины за прокси, из-за которого QUIC-туннели рвутся. Поэтому «поднять http.server на 8099»
и «отдать картинку вложением» — тупиковые пути.

Проверенный порядок (от лучшего к вспомогательному):

1. **Картинка прямо в чат** — `chrome-devtools_take_screenshot` из MCP **без `filePath`**:
   скриншот возвращается image-content и Pi Web рисует его в транскрипте с лайтбоксом
   (`appendImage` для `toolResult` в `public/app.js`). Именно так владелец и смотрит макеты.
   `read` PNG так не работает: вложения не отрисовываются в чате.
2. **`filePath`** у того же тула — сохраняет PNG на диск (в `.pi/artifacts/...`), картинка в чат
   не уходит. Так готовятся файлы для Files panel и для ссылки.
3. **Files panel Pi Web** — `/api/files` показывает и gitignored-пути (`.pi/**`), у PNG
   `canOpenInWebui: true`; HTML открывается как текст (`kind: "text"`), не рендерится.
4. **Ссылка для другого устройства** — публикация в `/srv/preview` →
   `https://pi.dnikulshin.ru:8443/preview/<slug>/`: снаружи проброшен **8443 → внутренний 443**
   (`docs/deploy.md`, `docs/staging.md`), поэтому ссылка без `:8443` не откроется; nginx
   слушает только 443, auth/TLS наследуются от server-блока pi. Публикация:
   тул `publish_preview` / команда `/share`, разовая настройка
   `sudo ~/.pi/agent/bin/preview-nginx-setup.sh`. Внутри хоста проверять так:
   `curl -sk --resolve pi.dnikulshin.ru:443:127.0.0.1 https://pi.dnikulshin.ru/preview/`
   (ожидается 401 — auth), а не через публичный IP: hairpin-NAT на роутере не работает.
5. **Публичные туннели** (`cloudflared --tunnel quick`) на этой сети не годятся: соединение
   регистрируется, но край отдаёт 502/530 (`datagram manager error: timeout`) — QUIC/UDP режется.
   Не тратить время повторно.

## 1. Где живут макеты

`.pi/artifacts/<YYYY-MM-DD>-<issue>-<slug>/` — каталог в `.gitignore`, в репозиторий не попадает.
Один каталог на итерацию: `README.md` (что это, какие варианты, что проверено) + HTML + PNG.
`index.html` в корне каталога — чтобы nginx отдавал галерею, а не autoindex.

## 2. Контент — реальный

Бери данные из dev-БД (MCP `postgres`, read-only) или из `contracts`, а не выдумывай
«Услуга 1 / 2500 ₽». Тонкий контент — нормальная ситуация: макет должен работать без фото.

## 3. Шрифты: Google Fonts на хосте недоступен

`https://fonts.googleapis.com` отдаёт `ERR_CONNECTION_RESET`, при этом npm работает.

```bash
npm i --prefix /tmp/design-fonts @fontsource/<family>     # unbounded, golos-text, onest, literata
mkdir -p fonts/files
cp /tmp/design-fonts/node_modules/@fontsource/<family>/<weight>.css fonts/<family>-<weight>.css
# в CSS пути ./files/... — скопировать только нужные woff2 из <family>/files/
```

- Кириллица обязательна: проверять, что семейство её содержит (`files/*-cyrillic-*.woff2`).
- В HTML — локальные `fonts/<family>-<weight>.css`, никаких `<link>` на Google.
- Приложение (`apps/web`): те же woff2 в `apps/web/src/app/fonts/` + `next/font/local`,
  без новой зависимости; лицензии OFL прикладывать. Новый dependency не нужен и не согласовывать.

## 4. Скриншоты — chrome-devtools MCP (у супервизора)

- `resize_page` 1440×900 (десктоп) и 390×844 (мобайл) → `navigate_page` (file:// или http://).
- `take_screenshot` с `fullPage: true`: **без `filePath`** — картинка уходит в чат владельцу;
  **с `filePath`** (абсолютный) — сохраняется файл, в чат не уходит.
- Показывать владельцу так: сначала все варианты в чате (пункт 1), файлы —
  для Files panel и ссылки.
- Playwright MCP тоже умеет снимать, но пишет только в файл и падает по таймауту 5 с
  на первом кадре; относительный путь он резолвит от корня репозитория и мусорит `git status`.

## 5. Проверки, которые считаются доказательством

Выполнять в браузере, а не «на глаз»:

```js
// переполнение по горизонтали и слишком маленькие тап-таргеты
() => ({
  overflowX: document.documentElement.scrollWidth - window.innerWidth,
  small: [...document.querySelectorAll('a,button,input,select')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.height > 0 && r.height < 24 }).length,
  fontOk: document.fonts.check('300 48px Unbounded'),
})
```

Контраст считать по WCAG: текст ≥ 4.5:1, крупный/служебный ≥ 3:1. Пары «токен на токене»
прогонять скриптом (sRGB → линейный → luminance), результат писать числами в README.
Клавиатура: `:focus-visible` виден, все интерактивные элементы достижимы табом.

## 6. Отчёт владельцу

Сначала картинки в чат (десктоп + мобайл каждого варианта), потом текст: что является
сигнатурой каждого направления, какие проверки прогнаны (числами), что осталось слабым,
и один вопрос-решение. Ссылку `/preview/` давать дополнительно, а не вместо картинок.
Не заявлять «проверено», если проверка не запускалась.

## 7. Границы

- Макеты не попадают в `apps/web` и не коммитятся; перенос в код — отдельной задачей
  (`design/*` ветка, скилл `hair-lab-api-contract` не нужен, контракты не трогаем).
- Никаких `sudo`/правок nginx в рамках задачи дизайна: разовая настройка уже сделана,
  иначе попросить владельца выполнить `preview-nginx-setup.sh`.
- Не публиковать в `/srv/preview` ничего с персональными данными и `.env*`.
