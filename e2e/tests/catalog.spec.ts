import { expect, test } from '@playwright/test';

import { collectConsoleErrors } from '../helpers';

/**
 * Сценарий «витрина» (issue #114): каталог приходит с api, а не из fallback-состояния.
 *
 * Проверяется именно то, что ломается без стенда: SSR-страница получает данные от api
 * (в Docker-образе web api ещё не поднят, поэтому «каталог временно недоступен» —
 * реальный регресс, который ловится здесь после сборки).
 */
test('каталог и услуги рендерятся с данными api', async ({ page }) => {
  const errors = collectConsoleErrors(page);

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText('каталог временно недоступен', { exact: false })).toHaveCount(0);

  await page.goto('/services');
  await expect(page.getByText('E2E стрижка').first()).toBeVisible();

  await page.goto('/masters');
  await expect(page.getByText('E2E Мастер').first()).toBeVisible();

  expect(errors).toEqual([]);
});
