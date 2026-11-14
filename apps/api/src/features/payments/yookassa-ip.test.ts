import { describe, expect, it } from 'vitest';
import { isYookassaIp } from './yookassa-ip';

/**
 * Проверка allowlist уведомлений ЮKassa: границы подсетей, точные адреса, IPv6,
 * IPv4-mapped IPv6 и мусор. Адреса настоящие (это публичный список провайдера),
 * персональных данных здесь нет.
 */
describe('isYookassaIp: подсети IPv4', () => {
  it('185.71.76.0/27: .0-.31 входят, .32 — нет', () => {
    expect(isYookassaIp('185.71.76.0')).toBe(true);
    expect(isYookassaIp('185.71.76.15')).toBe(true);
    expect(isYookassaIp('185.71.76.31')).toBe(true);
    expect(isYookassaIp('185.71.76.32')).toBe(false);
    expect(isYookassaIp('185.71.75.255')).toBe(false);
  });

  it('185.71.77.0/27: .0-.31 входят, .32 — нет', () => {
    expect(isYookassaIp('185.71.77.0')).toBe(true);
    expect(isYookassaIp('185.71.77.31')).toBe(true);
    expect(isYookassaIp('185.71.77.32')).toBe(false);
  });

  it('77.75.153.0/25: .0-.127 входят, .128 — нет', () => {
    expect(isYookassaIp('77.75.153.0')).toBe(true);
    expect(isYookassaIp('77.75.153.127')).toBe(true);
    expect(isYookassaIp('77.75.153.128')).toBe(false);
  });

  it('77.75.154.128/25: .128-.255 входят, .127 — нет', () => {
    expect(isYookassaIp('77.75.154.128')).toBe(true);
    expect(isYookassaIp('77.75.154.255')).toBe(true);
    expect(isYookassaIp('77.75.154.127')).toBe(false);
  });
});

describe('isYookassaIp: точные адреса', () => {
  it('77.75.156.11 и 77.75.156.35 разрешены, соседние — нет', () => {
    expect(isYookassaIp('77.75.156.11')).toBe(true);
    expect(isYookassaIp('77.75.156.35')).toBe(true);
    expect(isYookassaIp('77.75.156.12')).toBe(false);
    expect(isYookassaIp('77.75.156.36')).toBe(false);
  });
});

describe('isYookassaIp: IPv6', () => {
  it('2a02:5180::/32 разрешена целиком', () => {
    expect(isYookassaIp('2a02:5180::1')).toBe(true);
    expect(isYookassaIp('2a02:5180:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true);
    expect(isYookassaIp('2A02:5180::A')).toBe(true);
  });

  it('другие IPv6-адреса не проходят', () => {
    expect(isYookassaIp('2a02:5181::1')).toBe(false);
    expect(isYookassaIp('2a02:5179::1')).toBe(false);
    expect(isYookassaIp('::1')).toBe(false);
    expect(isYookassaIp('::')).toBe(false);
    expect(isYookassaIp('2001:db8::1')).toBe(false);
  });
});

describe('isYookassaIp: IPv4-mapped IPv6', () => {
  it('точечная форма сравнивается как IPv4', () => {
    expect(isYookassaIp('::ffff:185.71.76.5')).toBe(true);
    expect(isYookassaIp('::ffff:77.75.156.11')).toBe(true);
    expect(isYookassaIp('::FFFF:185.71.76.5')).toBe(true);
    expect(isYookassaIp('::ffff:8.8.8.8')).toBe(false);
    expect(isYookassaIp('::ffff:185.71.76.32')).toBe(false);
  });

  it('hex-форма mapped-адреса тоже распознаётся', () => {
    // ::ffff:b947:4c05 = 185.71.76.5
    expect(isYookassaIp('::ffff:b947:4c05')).toBe(true);
    // ::ffff:0808:0808 = 8.8.8.8
    expect(isYookassaIp('::ffff:0808:0808')).toBe(false);
  });

  it('mapped-адрес не считается IPv6-подсетью', () => {
    // Первые hextet'ы нулевые: без разворота в IPv4 адрес не должен проходить.
    expect(isYookassaIp('::ffff:0:1')).toBe(false);
  });
});

describe('isYookassaIp: нормализация и мусор', () => {
  it('пробелы, скобки и зона отбрасываются', () => {
    expect(isYookassaIp(' 185.71.76.5 ')).toBe(true);
    expect(isYookassaIp('[2a02:5180::1]')).toBe(true);
    expect(isYookassaIp('2a02:5180::1%eth0')).toBe(true);
  });

  it('пустая строка и не-адреса дают false', () => {
    for (const value of [
      '',
      '   ',
      'not-an-ip',
      '1.2.3',
      '1.2.3.4.5',
      '256.1.1.1',
      '1.2.3.999',
      '185.71.076.5x',
      '185.71.76.5:8080',
      '::gggg',
      '2a02:5180::1::2',
      '[::1',
      'localhost',
      '127.0.0.1',
      '10.0.0.1',
    ]) {
      expect(isYookassaIp(value), value).toBe(false);
    }
  });
});
