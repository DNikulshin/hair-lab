import { describe, expect, it } from 'vitest';
import { mapAccountError } from './map-account-error';

describe('mapAccountError', () => {
  it('объясняет истёкшую сессию и просит войти снова', () => {
    expect(
      mapAccountError({
        kind: 'http',
        status: 401,
        body: { error: { code: 'unauthorized', message: 'Технический текст' } },
      }),
    ).toContain('Войдите снова');
  });

  it('объясняет запрет отмены по правилам салона', () => {
    expect(mapAccountError({ kind: 'http', status: 409, body: null })).toContain(
      'отменить уже нельзя',
    );
    expect(
      mapAccountError({
        kind: 'http',
        status: 409,
        body: { error: { code: 'conflict', message: 'conflict' } },
      }),
    ).toContain('меньше двух часов');
  });

  it('сообщает, что запись не найдена, не раскрывая чужие записи', () => {
    const message = mapAccountError({ kind: 'http', status: 404, body: null });
    expect(message).toContain('Запись не найдена');
    expect(message).not.toContain('чуж');
  });

  it('считает сеть и недоступный сервис поводом повторить позже', () => {
    expect(mapAccountError({ kind: 'network' })).toContain('временно недоступен');
    expect(mapAccountError({ kind: 'http', status: 503, body: null })).toContain(
      'временно недоступен',
    );
    expect(mapAccountError({ kind: 'http', status: 502, body: null })).toContain(
      'временно недоступен',
    );
  });

  it('не выводит текст сервера и значения полей', () => {
    const message = mapAccountError({
      kind: 'http',
      status: 409,
      body: { error: { code: 'conflict', message: 'guest@example.invalid +79123456789' } },
    });
    expect(message).not.toContain('guest@example.invalid');
    expect(message).not.toContain('+79123456789');
  });

  it('на неизвестный статус даёт нейтральный текст', () => {
    expect(mapAccountError({ kind: 'http', status: 500, body: null })).toContain(
      'Не удалось выполнить запрос',
    );
  });
});
