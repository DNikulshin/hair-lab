import { expect, test } from '@playwright/test';

import { bookAppointment, collectConsoleErrors } from '../helpers';

/**
 * Сценарий «запись» (issue #114): визард создаёт запись через api.
 *
 * При `PAYMENTS_MODE=test` успешная запись ведёт на страницу оплаты — это и есть
 * проверка, что запись создана (сервер вернул 201 и ссылку на оплату).
 */
test('запись создаётся и ведёт на страницу оплаты', async ({ page }) => {
  const errors = collectConsoleErrors(page);

  await bookAppointment(page);

  await expect(page).toHaveURL(/\/booking\/payment\?appointmentId=/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Оплата записи' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Перейти к оплате' })).toBeVisible();

  expect(errors).toEqual([]);
});
