import { expect, test } from '@playwright/test';

/** Базовый адрес api стенда: уведомление провайдера отправляем прямо в него. */
const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3001';

import { bookAppointment, collectConsoleErrors } from '../helpers';

/**
 * Сценарий «оплата» (issue #114): провайдер заменён заглушкой `e2e/yookassa-stub.mjs`.
 *
 * Путь целиком: визард → страница оплаты → ссылка провайдера на заглушку → «Оплатить» →
 * возврат на страницу оплаты → свипер сверяет платёж у провайдера (`PAYMENT_SWEEP_INTERVAL_MS=1000`)
 * → экран сам показывает «Оплачено». Настоящий провайдер и деньги не участвуют.
 */
test('оплата через заглушку провайдера подтверждает запись', async ({ page, request }) => {
  const errors = collectConsoleErrors(page);

  await bookAppointment(page);
  await expect(page).toHaveURL(/\/booking\/payment\?appointmentId=/, { timeout: 20_000 });

  const paymentUrl = page.url();
  const payLink = page.getByRole('link', { name: 'Перейти к оплате' });
  await expect(payLink).toBeVisible();

  // Id платежа провайдера нужен для уведомления: он есть в ссылке на оплату.
  const payHref = await payLink.getAttribute('href');
  const gatewayPaymentId = payHref?.split('/pay/')[1] ?? '';
  expect(gatewayPaymentId).not.toBe('');

  await payLink.click();

  // Заглушка: страница оплаты с кнопкой. Здесь «клиент платит».
  await expect(page.getByTestId('stub-status')).toHaveText('Ждёт оплаты');
  await page.getByRole('button', { name: 'Оплатить' }).click();
  await expect(page.getByTestId('stub-status')).toHaveText('Оплачено');

  // Провайдер присылает уведомление — так платёж узнаёт api в проде. Заглушка за настоящего
  // провайдера не ходит, поэтому уведомление отправляет сам тест: адрес в `X-Forwarded-For`
  // из allowlist ЮKassa (в проде его ставит nginx, `trustProxy` включён). Тело уведомления
  // доказательством не считается: api перезапрашивает состояние у заглушки.
  const webhook = await request.post(`${API_URL}/payments/webhooks/yookassa`, {
    headers: { 'x-forwarded-for': '77.75.156.11' },
    data: {
      type: 'notification',
      event: 'payment.succeeded',
      object: { id: gatewayPaymentId, status: 'succeeded', paid: true },
    },
  });
  expect(webhook.status()).toBe(200);

  // `goBack` не годится: после POST заглушка отвечает редиректом, и в истории две её страницы.
  await page.goto(paymentUrl);
  await expect(page.getByRole('heading', { name: 'Оплата записи' })).toBeVisible();
  await expect(page.getByText('Оплачено', { exact: true })).toBeVisible({ timeout: 30_000 });

  expect(errors).toEqual([]);
});
