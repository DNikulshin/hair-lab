import { describe, expect, it } from 'vitest';
import { mapAdminError, mapStaffLoginError } from './map-admin-error';

/** Данные вымышленные: в «теле ошибки» лежат только тестовые значения. */

describe('mapAdminError', () => {
  it('просит войти снова, когда сессия истекла', () => {
    expect(
      mapAdminError({
        kind: 'http',
        status: 401,
        body: { error: { code: 'unauthorized', message: 'Технический текст' } },
      }),
    ).toContain('Войдите снова');
  });

  it('объясняет конфликт состояния и обещает обновить список', () => {
    expect(mapAdminError({ kind: 'http', status: 409, body: null })).toContain(
      'запись уже изменилась',
    );
  });

  it('сообщает, что запись не найдена', () => {
    expect(mapAdminError({ kind: 'http', status: 404, body: null })).toContain('Запись не найдена');
  });

  it('считает сеть и недоступный сервис поводом повторить позже', () => {
    expect(mapAdminError({ kind: 'network' })).toContain('временно недоступен');
    expect(mapAdminError({ kind: 'http', status: 503, body: null })).toContain(
      'временно недоступен',
    );
    expect(mapAdminError({ kind: 'http', status: 502, body: null })).toContain(
      'временно недоступен',
    );
  });

  it('не выводит текст сервера и значения полей', () => {
    const message = mapAdminError({
      kind: 'http',
      status: 409,
      body: { error: { code: 'conflict', message: 'guest@example.invalid +70000000001' } },
    });

    expect(message).not.toContain('guest@example.invalid');
    expect(message).not.toContain('+70000000001');
  });

  it('на неизвестный статус даёт нейтральный текст', () => {
    expect(mapAdminError({ kind: 'http', status: 500, body: null })).toContain(
      'Не удалось выполнить запрос',
    );
  });
});

describe('mapStaffLoginError', () => {
  it('на неверные данные отвечает нейтрально, не подсказывая про учётную запись', () => {
    const message = mapStaffLoginError({ kind: 'http', status: 401, body: null });

    expect(message).toBe('Неверный email или пароль.');
    expect(message).not.toContain('аккаунт');
  });

  it('объясняет ограничение попыток входа', () => {
    expect(
      mapStaffLoginError({
        kind: 'http',
        status: 429,
        body: { error: { code: 'rate_limited', message: 'rate limited' } },
      }),
    ).toContain('Слишком много попыток');
  });

  it('на сеть и неизвестный статус не обещает конкретики', () => {
    expect(mapStaffLoginError({ kind: 'network' })).toContain('временно недоступен');
    expect(mapStaffLoginError({ kind: 'http', status: 500, body: null })).toContain(
      'Не удалось выполнить запрос',
    );
  });
});
