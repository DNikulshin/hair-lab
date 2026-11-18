import { describe, expect, it } from 'vitest';
import { buildPaymentReturnUrl } from './payment-return-url';

/**
 * `return_url` для ЮKassa: база из окружения плюс id записи в query.
 * Значения вымышленные, ПДн в адресе нет — только uuid.
 */

const APPOINTMENT_ID = '33333333-3333-4333-8333-333333333333';
const BASE = 'https://salon.example.invalid/booking/payment';

describe('buildPaymentReturnUrl', () => {
  it('дописывает id через «?», если параметров в базе нет', () => {
    expect(buildPaymentReturnUrl(BASE, APPOINTMENT_ID)).toBe(
      `${BASE}?appointmentId=${APPOINTMENT_ID}`,
    );
  });

  it('дописывает id через «&», если в базе уже есть query', () => {
    expect(buildPaymentReturnUrl(`${BASE}?from=yookassa`, APPOINTMENT_ID)).toBe(
      `${BASE}?from=yookassa&appointmentId=${APPOINTMENT_ID}`,
    );
  });

  it('сохраняет фрагмент после query и не теряет уже заданные параметры', () => {
    expect(buildPaymentReturnUrl(`${BASE}?from=yookassa#paid`, APPOINTMENT_ID)).toBe(
      `${BASE}?from=yookassa&appointmentId=${APPOINTMENT_ID}#paid`,
    );
  });

  it('перезаписывает id, а не добавляет второй', () => {
    expect(
      buildPaymentReturnUrl(
        `${BASE}?appointmentId=11111111-1111-4111-8111-111111111111`,
        APPOINTMENT_ID,
      ),
    ).toBe(`${BASE}?appointmentId=${APPOINTMENT_ID}`);
  });

  it('принимает http (dev-стенд) и дописывает слэш к корню', () => {
    expect(buildPaymentReturnUrl('http://localhost:3000', APPOINTMENT_ID)).toBe(
      `http://localhost:3000/?appointmentId=${APPOINTMENT_ID}`,
    );
  });

  it('падает без id записи: ссылка без id оставила бы возврат без записи', () => {
    expect(() => buildPaymentReturnUrl(BASE, '')).toThrow(/id записи/);
    expect(() => buildPaymentReturnUrl(BASE, 'not-a-uuid')).toThrow(/id записи/);
  });

  it('падает на невалидной базе, а не отдаёт шлюзу мусор', () => {
    for (const base of ['', '/booking/payment', 'booking/payment', 'not a url']) {
      expect(() => buildPaymentReturnUrl(base, APPOINTMENT_ID)).toThrow(/базовый адрес/);
    }
    for (const base of ['javascript:alert(1)', 'data:text/html,1', 'ftp://salon.example.invalid']) {
      expect(() => buildPaymentReturnUrl(base, APPOINTMENT_ID)).toThrow(/только http/);
    }
  });
});
