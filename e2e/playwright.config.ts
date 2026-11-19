import { defineConfig, devices } from '@playwright/test';

/**
 * Браузерные тесты hair-lab (issue #114).
 *
 * Стенд поднимает `scripts/e2e.mjs`: временная база прогона, api с `PAYMENTS_MODE=test`
 * и заглушкой ЮKassa (`e2e/yookassa-stub.mjs`), production-сборка web. Playwright только
 * ходит по адресу `E2E_BASE_URL` — сам ничего не запускает, поэтому локально стенд можно
 * держать в отдельном терминале (`E2E_KEEP=1 pnpm e2e`).
 *
 * Постоянный один worker и последовательный прогон: сценарии работают с общим каталогом и
 * одной базой, параллельность дала бы гонку за слоты. Повтор в CI один — только на флаки
 * сети/старта, а не на логику (падение сценария не должно маскироваться).
 */
export default defineConfig({
  testDir: './tests',
  // Браузерные сценарии идут дольше юнит-тестов: старт страницы, запросы к api, опрос статуса.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI === 'true' || process.env.CI === '1' ? 1 : 0,
  reporter: process.env.CI === 'true' || process.env.CI === '1' ? [['list'], ['github']] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3003',
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
    // Заглушка ЮKassa работает по TLS с самоподписанным сертификатом: контракт требует
    // `https` в `confirmationUrl`, а свой сертификат в тестовом стенде — норма.
    ignoreHTTPSErrors: true,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
