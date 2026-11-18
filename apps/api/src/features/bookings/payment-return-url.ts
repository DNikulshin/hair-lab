import { idSchema } from '@hair-lab/contracts';

/**
 * Адрес возврата с платёжной страницы провайдера (`return_url` ЮKassa).
 *
 * База приходит из окружения (`YOOKASSA_RETURN_URL`, по умолчанию `${APP_URL}/booking/payment`),
 * а id записи дописывает сервис: возврат в другой вкладке или на другом устройстве не должен
 * зависеть от `sessionStorage` той вкладки, где оформляли запись.
 *
 * В query уезжает только uuid записи — ни телефона, ни почты, ни имени: ссылка остаётся
 * в истории браузера и в логах провайдера.
 *
 * Чистая функция без сети и состояния: сепаратор выбирается по наличию `?` в базе, поэтому
 * работают и голый путь, и адрес с уже заданными параметрами (`?from=yookassa`).
 */
export function buildPaymentReturnUrl(baseUrl: string, appointmentId: string): string {
  const id = idSchema.safeParse(appointmentId);
  if (!id.success) throw new Error('return_url: некорректный id записи');

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error('return_url: базовый адрес не является абсолютным URL');
  }
  // `javascript:`/`data:` в адресе возврата недопустимы так же, как и в ссылке на оплату.
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new Error('return_url: поддерживаются только http(s)');
  }

  // `URL` сам ставит `?`/`&` и кодирует значение; фрагмент и прочие параметры сохраняются.
  base.searchParams.set('appointmentId', id.data);
  return base.toString();
}
