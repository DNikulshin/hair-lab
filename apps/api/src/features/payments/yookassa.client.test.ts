import { describe, expect, it } from 'vitest';
import {
  amountValueToKopecks,
  createYookassaClient,
  kopecksToAmountValue,
  YookassaRequestError,
} from './yookassa.client';

/**
 * Клиент ЮKassa на подменённом `fetch`: проверяем, что уходит в сеть (заголовки, суммы, тело)
 * и что не утекает наружу (секрет, тело ответа). Ключи магазина вымышленные.
 */
const SHOP_ID = 'shop-id-0001';
const SECRET_KEY = 'test-secret-value';
const APPOINTMENT_ID = '33333333-3333-4333-8333-333333333333';
const YOOKASSA_PAYMENT_ID = '2a1b0d2f-000f-5000-9000-1f0000000000';
const API_URL = 'https://api.yookassa.example.invalid/v3';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

/** Подменённый `fetch`: запоминает запрос и отвечает заранее заданным результатом. */
function createFetch(response: { status: number; body: string } | Error): {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? undefined,
    });

    if (response instanceof Error) throw response;

    return new Response(response.body, {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return { fetchImpl, requests };
}

function createClient(response: { status: number; body: string } | Error) {
  const { fetchImpl, requests } = createFetch(response);
  const client = createYookassaClient({
    shopId: SHOP_ID,
    secretKey: SECRET_KEY,
    apiUrl: API_URL,
    fetchImpl,
  });
  return { client, requests };
}

describe('конвертация суммы', () => {
  it('копейки → строка без потери точности', () => {
    expect(kopecksToAmountValue(1)).toBe('0.01');
    expect(kopecksToAmountValue(99)).toBe('0.99');
    expect(kopecksToAmountValue(100)).toBe('1.00');
    expect(kopecksToAmountValue(350_000)).toBe('3500.00');
    expect(kopecksToAmountValue(12_345_678_901)).toBe('123456789.01');
  });

  it('отклоняет неположительные и дробные копейки', () => {
    expect(() => kopecksToAmountValue(0)).toThrow(RangeError);
    expect(() => kopecksToAmountValue(-100)).toThrow(RangeError);
    expect(() => kopecksToAmountValue(10.5)).toThrow(RangeError);
  });

  it('строка от ЮKassa → копейки', () => {
    expect(amountValueToKopecks('3500.00')).toBe(350_000);
    expect(amountValueToKopecks('0.01')).toBe(1);
    expect(amountValueToKopecks('1.5')).toBe(150);
    expect(amountValueToKopecks('100')).toBe(10_000);
    expect(amountValueToKopecks(' 3500.00 ')).toBe(350_000);
  });

  it('некорректные суммы дают null, а не NaN и не округление', () => {
    for (const value of ['', '35,00', 'abc', '3500.001', '-3500.00', '3500.00.0', '1e5']) {
      expect(amountValueToKopecks(value), value).toBeNull();
    }
  });

  it('обе конверсии — взаимно обратные', () => {
    for (const kopecks of [1, 7, 99, 100, 101, 350_000, 5_000_000]) {
      expect(amountValueToKopecks(kopecksToAmountValue(kopecks))).toBe(kopecks);
    }
  });
});

describe('createPayment', () => {
  const successBody = JSON.stringify({
    id: YOOKASSA_PAYMENT_ID,
    status: 'pending',
    paid: false,
    amount: { value: '3500.00', currency: 'RUB' },
    confirmation: { type: 'redirect', confirmation_url: 'https://yoomoney.example.invalid/pay' },
    expires_at: '2030-03-04T06:15:00.000Z',
  });

  it('отправляет Basic Auth, Idempotence-Key и сумму в рублях', async () => {
    const { client, requests } = createClient({ status: 200, body: successBody });

    const created = await client.createPayment({
      appointmentId: APPOINTMENT_ID,
      amountKopecks: 350_000,
      description: 'Оплата записи: Стрижка',
      returnUrl: 'https://salon.example.invalid/booking/payment',
      idempotenceKey: `payment-${APPOINTMENT_ID}`,
    });

    const request = requests[0];
    expect(request?.url).toBe(`${API_URL}/payments`);
    expect(request?.method).toBe('POST');
    expect(request?.headers['Authorization']).toBe(
      `Basic ${Buffer.from(`${SHOP_ID}:${SECRET_KEY}`).toString('base64')}`,
    );
    expect(request?.headers['Idempotence-Key']).toBe(`payment-${APPOINTMENT_ID}`);
    expect(request?.headers['Content-Type']).toBe('application/json');
    // Таймаут: запрос должен быть прерываемым.
    expect(request?.signal).toBeInstanceOf(AbortSignal);

    expect(request?.body).toEqual({
      amount: { value: '3500.00', currency: 'RUB' },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: 'https://salon.example.invalid/booking/payment',
      },
      description: 'Оплата записи: Стрижка',
      // ПДн в шлюз не уходят: только id записи.
      metadata: { appointmentId: APPOINTMENT_ID },
    });

    expect(created).toEqual({
      yookassaPaymentId: YOOKASSA_PAYMENT_ID,
      confirmationUrl: 'https://yoomoney.example.invalid/pay',
      expiresAt: '2030-03-04T06:15:00.000Z',
    });
  });

  it('без срока действия ссылки возвращает платёж без expiresAt', async () => {
    const body = JSON.parse(successBody) as Record<string, unknown>;
    delete body['expires_at'];
    const { client } = createClient({ status: 200, body: JSON.stringify(body) });

    const created = await client.createPayment({
      appointmentId: APPOINTMENT_ID,
      amountKopecks: 100,
      description: 'Оплата записи: Стрижка',
      returnUrl: 'https://salon.example.invalid/booking/payment',
      idempotenceKey: 'payment-1',
    });

    expect(created.expiresAt).toBeUndefined();
  });

  it('ответ без ссылки на оплату — ошибка, а не пустая ссылка в ответе API', async () => {
    const { client } = createClient({
      status: 200,
      body: JSON.stringify({ id: YOOKASSA_PAYMENT_ID, status: 'pending' }),
    });

    await expect(
      client.createPayment({
        appointmentId: APPOINTMENT_ID,
        amountKopecks: 100,
        description: 'Оплата записи: Стрижка',
        returnUrl: 'https://salon.example.invalid/booking/payment',
        idempotenceKey: 'payment-1',
      }),
    ).rejects.toThrow(YookassaRequestError);
  });
});

describe('ошибки', () => {
  it('не-2xx: HTTP-код и code, без тела ответа и без секрета', async () => {
    const description = 'Incorrect shopId or secretKey';
    const { client } = createClient({
      status: 401,
      body: JSON.stringify({ type: 'error', code: 'invalid_credentials', description }),
    });

    const error = await client.getPayment(YOOKASSA_PAYMENT_ID).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(YookassaRequestError);
    expect((error as YookassaRequestError).httpStatus).toBe(401);
    expect((error as YookassaRequestError).code).toBe('invalid_credentials');
    expect((error as Error).message).not.toContain(SECRET_KEY);
    // Текст ошибки не пересказывает тело ответа целиком.
    expect((error as Error).message).not.toContain(description);
    expect((error as Error).message).not.toContain(SHOP_ID);
  });

  it('сетевая ошибка: код network_error без деталей запроса', async () => {
    const { client } = createClient(new Error(`connect ECONNREFUSED ${SECRET_KEY}`));

    const error = await client.getPayment(YOOKASSA_PAYMENT_ID).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(YookassaRequestError);
    expect((error as YookassaRequestError).httpStatus).toBe(0);
    expect((error as YookassaRequestError).code).toBe('network_error');
    expect((error as Error).message).not.toContain(SECRET_KEY);
  });

  it('невалидный code в теле ошибки не попадает в ошибку', async () => {
    const { client } = createClient({
      status: 500,
      body: JSON.stringify({ code: `секрет ${SECRET_KEY}`, description: 'boom' }),
    });

    const error = await client.getPayment(YOOKASSA_PAYMENT_ID).catch((thrown: unknown) => thrown);

    expect((error as YookassaRequestError).code).toBeUndefined();
    expect((error as Error).message).not.toContain(SECRET_KEY);
  });

  it('не-JSON ответ считается некорректным', async () => {
    const { client } = createClient({ status: 200, body: '<html></html>' });

    const error = await client.getPayment(YOOKASSA_PAYMENT_ID).catch((thrown: unknown) => thrown);

    expect((error as YookassaRequestError).code).toBe('invalid_response');
  });

  it('пустой idempotenceKey — ошибка до сетевого вызова', async () => {
    const { client, requests } = createClient({ status: 200, body: '{}' });

    await expect(
      client.createRefund({
        yookassaPaymentId: YOOKASSA_PAYMENT_ID,
        amountKopecks: 100,
        idempotenceKey: ' ',
      }),
    ).rejects.toThrow(RangeError);
    expect(requests).toHaveLength(0);
  });
});

describe('getPayment', () => {
  function paymentBody(status: string, paid: boolean, value = '3500.00'): string {
    return JSON.stringify({
      id: YOOKASSA_PAYMENT_ID,
      status,
      paid,
      amount: { value, currency: 'RUB' },
    });
  }

  it('succeeded с paid=true — деньги получены, сумма в копейках', async () => {
    const { client, requests } = createClient({
      status: 200,
      body: paymentBody('succeeded', true),
    });

    const payment = await client.getPayment(YOOKASSA_PAYMENT_ID);

    expect(requests[0]?.url).toBe(`${API_URL}/payments/${YOOKASSA_PAYMENT_ID}`);
    expect(requests[0]?.method).toBe('GET');
    // Перезапрос состояния не идемпотентен по ключу: Idempotence-Key не нужен.
    expect(requests[0]?.headers['Idempotence-Key']).toBeUndefined();
    expect(payment).toEqual({
      id: YOOKASSA_PAYMENT_ID,
      status: 'succeeded',
      paid: true,
      amountKopecks: 350_000,
    });
  });

  it('waiting_for_capture читается как pending и не считается оплатой', async () => {
    const { client } = createClient({
      status: 200,
      body: paymentBody('waiting_for_capture', true),
    });

    const payment = await client.getPayment(YOOKASSA_PAYMENT_ID);

    expect(payment.status).toBe('pending');
    expect(payment.paid).toBe(false);
  });

  it('canceled читается как canceled', async () => {
    const { client } = createClient({ status: 200, body: paymentBody('canceled', false) });

    await expect(client.getPayment(YOOKASSA_PAYMENT_ID)).resolves.toMatchObject({
      status: 'canceled',
      paid: false,
    });
  });

  it('неизвестный статус или сумма — некорректный ответ', async () => {
    const unknown = createClient({ status: 200, body: paymentBody('refunded', false) });
    await expect(unknown.client.getPayment(YOOKASSA_PAYMENT_ID)).rejects.toThrow(
      /Некорректный ответ/,
    );

    const badAmount = createClient({ status: 200, body: paymentBody('succeeded', true, '35') });
    await expect(badAmount.client.getPayment(YOOKASSA_PAYMENT_ID)).resolves.toMatchObject({
      amountKopecks: 3500,
    });

    const brokenAmount = createClient({
      status: 200,
      body: paymentBody('succeeded', true, '35.001'),
    });
    await expect(brokenAmount.client.getPayment(YOOKASSA_PAYMENT_ID)).rejects.toThrow(
      /Некорректный ответ/,
    );
  });
});

describe('createRefund', () => {
  it('отправляет payment_id, сумму и Idempotence-Key', async () => {
    const { client, requests } = createClient({
      status: 200,
      body: JSON.stringify({ id: 'refund-1', status: 'pending' }),
    });

    const refund = await client.createRefund({
      yookassaPaymentId: YOOKASSA_PAYMENT_ID,
      amountKopecks: 350_000,
      idempotenceKey: `refund-${YOOKASSA_PAYMENT_ID}`,
    });

    expect(requests[0]?.url).toBe(`${API_URL}/refunds`);
    expect(requests[0]?.headers['Idempotence-Key']).toBe(`refund-${YOOKASSA_PAYMENT_ID}`);
    expect(requests[0]?.body).toEqual({
      payment_id: YOOKASSA_PAYMENT_ID,
      amount: { value: '3500.00', currency: 'RUB' },
    });
    expect(refund).toEqual({ refundId: 'refund-1', status: 'pending' });
  });
});

describe('базовый адрес API', () => {
  it('хвостовой слэш в apiUrl не даёт двойного слэша в пути', async () => {
    const { fetchImpl, requests } = createFetch({
      status: 200,
      body: JSON.stringify({
        id: YOOKASSA_PAYMENT_ID,
        status: 'succeeded',
        paid: true,
        amount: { value: '1.00', currency: 'RUB' },
      }),
    });
    const client = createYookassaClient({
      shopId: SHOP_ID,
      secretKey: SECRET_KEY,
      apiUrl: `${API_URL}/`,
      fetchImpl,
    });

    await client.getPayment(YOOKASSA_PAYMENT_ID);

    expect(requests[0]?.url).toBe(`${API_URL}/payments/${YOOKASSA_PAYMENT_ID}`);
  });
});
