import { expect, test } from '@playwright/test';

/**
 * Сценарий «офлайн» (issue #114): service worker из production-сборки отдаёт офлайн-страницу,
 * а приватные ответы API не кэширует.
 *
 * Проверяется то, что нельзя увидеть юнит-тестом: регистрация SW, precache и навигация без сети.
 */
test('service worker отдаёт офлайн-страницу для навигации', async ({ page, context }) => {
  await page.goto('/');

  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toContain('127.0.0.1');

  const cacheNames = await page.evaluate(async () => caches.keys());
  expect(cacheNames.length).toBeGreaterThan(0);

  // Приватные данные API в кэш не попадают: проверяем содержимое каждого кэша.
  for (const name of cacheNames) {
    const urls = await page.evaluate(
      async (cacheName: string) =>
        (await (await caches.open(cacheName)).keys()).map((request) => request.url),
      name,
    );
    expect(urls.filter((url: string) => url.includes('/api/'))).toEqual([]);
  }

  await context.setOffline(true);
  await page.goto('/services').catch(() => {
    // Навигация без сети может отклониться до ответа SW: тогда страницу проверим после неё.
  });
  await expect(page.getByRole('heading', { name: 'Нет подключения' })).toBeVisible({
    timeout: 20_000,
  });

  await context.setOffline(false);
});
