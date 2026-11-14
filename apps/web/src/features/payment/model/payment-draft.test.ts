import { describe, expect, it } from 'vitest';
import type { Booking, BookingPayment } from '@hair-lab/contracts';
import {
  clearPaymentDraft,
  paymentHandoff,
  paymentPagePath,
  PAYMENT_DRAFT_KEY,
  PAYMENT_PATH,
  readPaymentDraft,
  savePaymentDraft,
  type PaymentDraft,
  type PaymentDraftStorage,
} from './payment-draft';

/** Вымышленные значения: реальных записей и ссылок в тестах быть не должно. */
const APPOINTMENT_ID = '0b9c7d1e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
const OTHER_ID = '1c2d3e4f-5a6b-4c7d-9e8f-1a2b3c4d5e6f';

const PAYMENT: BookingPayment = {
  confirmationUrl: 'https://yoomoney.test/checkout/payment/example-1',
  expiresAt: '2030-03-04T10:15:00.000Z',
};

const DRAFT: PaymentDraft = { appointmentId: APPOINTMENT_ID, ...PAYMENT };

/** Подделка `sessionStorage`: Map, как в браузере, но без DOM. */
interface FakeStorage extends PaymentDraftStorage {
  readonly data: Map<string, string>;
}

function createStorage(initial: Record<string, string> = {}): FakeStorage {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

/** Хранилище, которое падает на любом обращении: приватный режим Safari, запрет cookie. */
const brokenStorage: PaymentDraftStorage = {
  getItem: () => {
    throw new Error('SecurityError: доступ к sessionStorage запрещён');
  },
  setItem: () => {
    throw new Error('QuotaExceededError: хранилище недоступно');
  },
  removeItem: () => {
    throw new Error('SecurityError: доступ к sessionStorage запрещён');
  },
};

/** Запись из ответа `POST /bookings`: оплата включена, запись ждёт предоплаты. */
function bookingWithPayment(payment?: BookingPayment): Pick<Booking, 'id' | 'payment'> {
  return {
    id: APPOINTMENT_ID,
    ...(payment === undefined ? {} : { payment }),
  };
}

describe('savePaymentDraft / readPaymentDraft', () => {
  it('сохраняет черновик в sessionStorage и читает его обратно', () => {
    const storage = createStorage();

    expect(savePaymentDraft(DRAFT, storage)).toBe(true);
    expect(readPaymentDraft(storage)).toEqual(DRAFT);
    expect(storage.data.get(PAYMENT_DRAFT_KEY)).toBe(JSON.stringify(DRAFT));
  });

  it('перезапись заменяет прежний черновик', () => {
    const storage = createStorage();
    savePaymentDraft(DRAFT, storage);
    savePaymentDraft({ ...DRAFT, appointmentId: OTHER_ID }, storage);

    expect(readPaymentDraft(storage)?.appointmentId).toBe(OTHER_ID);
    expect(storage.data.size).toBe(1);
  });

  it('без хранилища чтение и запись безопасны', () => {
    expect(savePaymentDraft(DRAFT, null)).toBe(false);
    expect(readPaymentDraft(null)).toBeNull();
    expect(() => clearPaymentDraft(null)).not.toThrow();
  });

  it('пустое хранилище — черновика нет', () => {
    expect(readPaymentDraft(createStorage())).toBeNull();
  });

  it('падение хранилища не выбрасывает исключение', () => {
    expect(savePaymentDraft(DRAFT, brokenStorage)).toBe(false);
    expect(readPaymentDraft(brokenStorage)).toBeNull();
    expect(() => clearPaymentDraft(brokenStorage)).not.toThrow();
  });

  it('черновик пишется без персональных данных: только id, ссылка и срок', () => {
    const storage = createStorage();
    savePaymentDraft(DRAFT, storage);

    const saved = JSON.parse(storage.data.get(PAYMENT_DRAFT_KEY) ?? '{}') as Record<
      string,
      unknown
    >;

    expect(Object.keys(saved).sort()).toEqual(['appointmentId', 'confirmationUrl', 'expiresAt']);
  });
});

describe('savePaymentDraft: валидация контрактами', () => {
  it.each([
    ['не-uuid записи', { ...DRAFT, appointmentId: 'не-uuid' }],
    ['битая ссылка провайдера', { ...DRAFT, confirmationUrl: 'checkout/payment/1' }],
    ['пустая ссылка', { ...DRAFT, confirmationUrl: '' }],
    ['не ISO срок', { ...DRAFT, expiresAt: 'завтра' }],
  ])('отклоняет черновик: %s', (_label, draft) => {
    const storage = createStorage();

    expect(savePaymentDraft(draft as PaymentDraft, storage)).toBe(false);
    expect(storage.data.size).toBe(0);
  });
});

describe('readPaymentDraft: невалидное хранилище', () => {
  it('не JSON — черновика нет, значение удалено', () => {
    const storage = createStorage({ [PAYMENT_DRAFT_KEY]: '{ не json' });

    expect(readPaymentDraft(storage)).toBeNull();
    expect(storage.data.has(PAYMENT_DRAFT_KEY)).toBe(false);
  });

  it('JSON без обязательных полей — черновик удалён', () => {
    const storage = createStorage({
      [PAYMENT_DRAFT_KEY]: JSON.stringify({ appointmentId: APPOINTMENT_ID }),
    });

    expect(readPaymentDraft(storage)).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it('чужой формат (не объект) — черновик удалён', () => {
    const storage = createStorage({ [PAYMENT_DRAFT_KEY]: '"строка"' });

    expect(readPaymentDraft(storage)).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it('не-uuid в записи — черновик удалён', () => {
    const storage = createStorage({
      [PAYMENT_DRAFT_KEY]: JSON.stringify({ ...DRAFT, appointmentId: '42' }),
    });

    expect(readPaymentDraft(storage)).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it('лишние поля игнорируются: черновик сужается до трёх', () => {
    const storage = createStorage({
      [PAYMENT_DRAFT_KEY]: JSON.stringify({ ...DRAFT, clientPhone: '+79000000000' }),
    });

    expect(readPaymentDraft(storage)).toEqual(DRAFT);
  });
});

describe('clearPaymentDraft', () => {
  it('удаляет черновик', () => {
    const storage = createStorage();
    savePaymentDraft(DRAFT, storage);

    clearPaymentDraft(storage);

    expect(storage.data.size).toBe(0);
    expect(readPaymentDraft(storage)).toBeNull();
  });
});

describe('paymentPagePath', () => {
  it('ведёт на страницу оплаты с uuid записи', () => {
    expect(paymentPagePath(APPOINTMENT_ID)).toBe(`${PAYMENT_PATH}?appointmentId=${APPOINTMENT_ID}`);
  });

  it('экранирует значение параметра', () => {
    expect(paymentPagePath('a b&c')).toBe(`${PAYMENT_PATH}?appointmentId=a%20b%26c`);
  });
});

describe('paymentHandoff', () => {
  it('запись с оплатой: черновик и путь страницы оплаты', () => {
    const handoff = paymentHandoff(bookingWithPayment(PAYMENT));

    expect(handoff).toEqual({
      draft: DRAFT,
      path: `${PAYMENT_PATH}?appointmentId=${APPOINTMENT_ID}`,
    });
  });

  it('запись без оплаты (PAYMENTS_MODE=off): перевода на оплату нет', () => {
    expect(paymentHandoff(bookingWithPayment())).toBeNull();
    expect(paymentHandoff({ id: APPOINTMENT_ID })).toBeNull();
  });

  it('оплата с битой ссылкой не превращается в черновик', () => {
    const handoff = paymentHandoff(
      bookingWithPayment({ confirmationUrl: 'checkout', expiresAt: PAYMENT.expiresAt }),
    );

    expect(handoff).toBeNull();
  });
});
