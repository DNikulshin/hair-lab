import { describe, expect, it } from 'vitest';
import { maskPhone, normalizePhone, phoneSchema } from './phone';

/**
 * Телефоны только вымышленные: номера не принадлежат реальным людям
 * (для NANP взят зарезервированный для примеров диапазон 555-01xx).
 * Проверяем нормализацию, отказ от мусора и то, что значение номера не попадает в текст ошибки.
 */

describe('normalizePhone', () => {
  it('приводит разные записи российского номера к E.164', () => {
    expect(normalizePhone('+79123456789')).toBe('+79123456789');
    expect(normalizePhone('79123456789')).toBe('+79123456789');
    expect(normalizePhone('89123456789')).toBe('+79123456789');
    expect(normalizePhone('8 (912) 345-67-89')).toBe('+79123456789');
    expect(normalizePhone('  +7 912 345 67 89  ')).toBe('+79123456789');
    expect(normalizePhone('8-912-345-67-89')).toBe('+79123456789');
    expect(normalizePhone('8(912)3456789')).toBe('+79123456789');
    // Десять цифр с ведущей девяткой — российский номер без кода страны.
    expect(normalizePhone('9123456789')).toBe('+79123456789');
    expect(normalizePhone('9 (12) 345-67-89')).toBe('+79123456789');
  });

  it('принимает международный номер с плюсом и оставляет его как есть', () => {
    expect(normalizePhone('+1 202 555 0143')).toBe('+12025550143');
    expect(normalizePhone('+442071838750')).toBe('+442071838750');
    expect(normalizePhone('+44 20 7183 8750')).toBe('+442071838750');
  });

  it('понимает разделители: пробелы (включая неразрывный), дефисы, скобки, точки', () => {
    expect(normalizePhone('8\u00a0912\u00a0345\u00a067\u00a089')).toBe('+79123456789');
    expect(normalizePhone('8.912.345.67.89')).toBe('+79123456789');
    expect(normalizePhone('+1.202.555.0143')).toBe('+12025550143');
    expect(normalizePhone('+1 (202) 555-0143')).toBe('+12025550143');
  });

  it('отклоняет не-телефоны: обрезанные, короткие, длинные и текстовые значения', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
    expect(normalizePhone('1234567')).toBeNull();
    expect(normalizePhone('91234567')).toBeNull();
    // Десять цифр с ведущей восьмёркой — обрезанный российский номер.
    expect(normalizePhone('8 (912) 345-67-8')).toBeNull();
    expect(normalizePhone('8912345678')).toBeNull();
    expect(normalizePhone('891234567890')).toBeNull();
    expect(normalizePhone('+1 202 555 01')).toBeNull();
    expect(normalizePhone('+1202555014300000')).toBeNull();
    expect(normalizePhone('8 (912) 345-67-89 доб. 12')).toBeNull();
    expect(normalizePhone('телефон')).toBeNull();
    expect(normalizePhone('8'.repeat(40))).toBeNull();
  });
});

describe('phoneSchema', () => {
  it('нормализует значение поля, принимая российскую и международную запись', () => {
    expect(phoneSchema.parse(' 8 (912) 345-67-89 ')).toBe('+79123456789');
    expect(phoneSchema.parse('+70000000000')).toBe('+70000000000');
    expect(phoneSchema.parse('+1 202 555 0143')).toBe('+12025550143');
  });

  it('отклоняет мусор, не повторяя введённое значение в тексте ошибки', () => {
    const result = phoneSchema.safeParse('+1 999 000 00');
    expect(result.success).toBe(false);

    const message = result.success ? '' : result.error.issues[0]?.message;
    expect(message).toBeDefined();
    expect(message).not.toContain('999');
    expect(message).not.toContain('+1');
    expect(message).toContain('+7 XXX XXX-XX-XX');
    expect(message).toContain('международный');
  });
});

describe('maskPhone', () => {
  it('для российского номера оставляет привычный вид с последними двумя цифрами', () => {
    expect(maskPhone('+79123456789')).toBe('+7 (***) ***-**-89');
    expect(maskPhone('+70000000000')).toBe('+7 (***) ***-**-00');
  });

  it('маскирует российский номер, записанный не в E.164: старые строки не ломают ответ', () => {
    expect(maskPhone('8 (912) 345-67-89')).toBe('+7 (***) ***-**-89');
    expect(maskPhone('89123456789')).toBe('+7 (***) ***-**-89');
  });

  it('для международного номера показывает код страны и последние две цифры', () => {
    expect(maskPhone('+12025550143')).toBe('+1 ********43');
    expect(maskPhone('+1 202 555 0143')).toBe('+1 ********43');
    expect(maskPhone('+442071838750')).toBe('+44 ********50');
  });

  it('для нераспознанного значения не падает и не показывает цифры целиком', () => {
    expect(maskPhone('1234567')).toBe('+1 ****67');
    expect(maskPhone('')).toBe('+***');
  });

  it('не отдаёт номер целиком', () => {
    const phones = ['+79123456789', '+12025550143', '+442071838750'];
    for (const phone of phones) {
      const masked = maskPhone(phone);
      expect(masked).not.toBe(phone);
      expect(masked).not.toContain(phone.slice(1, -2));
      expect(masked.match(/\d/g)?.length ?? 0).toBeLessThan(phone.replace(/\D/g, '').length);
    }
  });
});
