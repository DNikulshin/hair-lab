import { expect, type Page } from '@playwright/test';

/**
 * Общие шаги сценариев (issue #114). Каталог стенда засеян `e2e/seed.sql`:
 * одна услуга «E2E стрижка», один мастер «E2E Мастер», рабочие часы 10:00–20:00 каждый день.
 */

/** Текст услуги и мастера из сида: сценарии не зависят от наполнения dev-БД. */
export const SEED = Object.freeze({
  serviceName: 'E2E стрижка',
  masterName: 'E2E Мастер',
});

/** Уникальный телефон на прогон: лимиты записи считаются по номеру (см. #106). */
let bookingSequence = 0;

function nextPhone(): string {
  bookingSequence += 1;
  return `+7900${String(1_000_000 + bookingSequence).slice(0, 7)}`;
}

/** Собирает непустые сообщения консоли — сценарии падают на ошибках своих страниц. */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

/**
 * Проходит визард записи: услуга → мастер → дата → слот → контакты → «Записаться».
 * Возвращает выбранное время, чтобы сценарий мог проверить его на следующем экране.
 */
export async function bookAppointment(page: Page): Promise<{ time: string; phone: string }> {
  await page.goto('/book');

  const service = page.locator('#booking-service');
  await expect(service).toBeVisible();
  // Ждём, пока каталог загрузится с api: до этого в селекте только пустой пункт.
  const serviceOption = service.locator('option', { hasText: SEED.serviceName });
  await expect(serviceOption).toHaveCount(1, { timeout: 20_000 });
  // `selectOption({ label })` не принимает шаблон: берём id из самого пункта.
  await service.selectOption((await serviceOption.getAttribute('value')) ?? '');

  const master = page.locator('#booking-master');
  const masterOption = master.locator('option', { hasText: SEED.masterName });
  await expect(masterOption).toHaveCount(1);
  await master.selectOption((await masterOption.getAttribute('value')) ?? '');

  const date = page.locator('#booking-date');
  await expect(date.locator('option')).not.toHaveCount(0);

  const slot = page.locator(
    '#booking-slots ~ * button, section[aria-labelledby="booking-slots"] button',
  );
  // Первая дата в списке — сегодня. Если предыдущие сценарии заняли дневные слоты (или прогон
  // идёт поздно), свободного времени на сегодня нет. Перебираем даты со второй и берём первую,
  // где слоты появились: сценарий не зависит ни от порядка тестов, ни от часа прогона.
  const dates = await date
    .locator('option')
    .evaluateAll((options) => options.map((option) => option.getAttribute('value') ?? ''));
  let found = false;
  for (const value of dates.slice(1)) {
    if (value === '') continue;
    await date.selectOption(value);
    try {
      await expect(slot.first()).toBeVisible({ timeout: 8_000 });
      found = true;
      break;
    } catch {
      // На этой дате свободного времени нет — пробуем следующую.
    }
  }
  expect(found, 'ни на одну дату нет свободных слотов').toBe(true);

  const time = (await slot.first().innerText()).trim();
  await slot.first().click();
  await expect(slot.first()).toHaveAttribute('aria-pressed', 'true');

  const phone = nextPhone();
  await page.locator('#booking-name').fill('Тест Браузерный');
  await page.locator('#booking-phone').fill(phone);

  await page.getByRole('button', { name: 'Записаться' }).click();
  return { time, phone };
}
