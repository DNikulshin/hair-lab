import { describe, expect, it } from 'vitest';
import { applyBasePath } from './api';

describe('applyBasePath', () => {
  it('добавляет базу к абсолютному пути', () => {
    expect(applyBasePath('/absproxy/3002', '/api/slots?serviceId=1')).toBe(
      '/absproxy/3002/api/slots?serviceId=1',
    );
  });

  it('без базы путь не меняется — прод и тесты работают как раньше', () => {
    expect(applyBasePath('', '/api/account/bookings')).toBe('/api/account/bookings');
  });

  it('убирает хвостовой слэш и повторные слэши в базе', () => {
    expect(applyBasePath('/absproxy/3002/', '/api/auth/me')).toBe('/absproxy/3002/api/auth/me');
    expect(applyBasePath('/absproxy/3002///', '/api/auth/me')).toBe('/absproxy/3002/api/auth/me');
  });

  it('не трогает относительные пути и абсолютные URL', () => {
    expect(applyBasePath('/base', 'api/slots')).toBe('api/slots');
    expect(applyBasePath('/base', 'https://example.invalid/api')).toBe(
      'https://example.invalid/api',
    );
  });

  it('вложенный basePath не дублируется', () => {
    expect(applyBasePath('/absproxy/3002', '/api/slots')).not.toContain('/absproxy/3002/absproxy');
  });
});
