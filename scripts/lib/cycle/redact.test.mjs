import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { redactLog, redactPatch, redactQa, scanSecrets } from './redact.mjs';

/** Корень фикстур: `scripts/fixtures/cycle/`. */
const FIXTURES = new URL('../../fixtures/cycle/', import.meta.url);

/**
 * Разобранный JSON-фикстур.
 * @param {string} name имя файла
 * @returns {any}
 */
function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
}

describe('redactLog: маскирование по таблице §5.4', () => {
  test('e-mail заменяется на [email]', () => {
    assert.equal(redactLog('клиент user@example.com записался'), 'клиент [email] записался');
  });

  test('телефоны в форматах +7, 8 и общем международном', () => {
    assert.equal(redactLog('+79990000000'), '[phone]');
    assert.equal(redactLog('+7 (999) 000-00-00'), '[phone]');
    assert.equal(redactLog('8 (999) 000-00-00'), '[phone]');
    assert.equal(redactLog('8-999-000-00-00'), '[phone]');
    assert.equal(redactLog('+1 (555) 010-0100'), '[phone]');
  });

  test('значения authorization, cookie и set-cookie заменяются на [secret]', () => {
    assert.equal(redactLog('Authorization: Bearer abcdef123456'), 'Authorization: [secret]');
    assert.equal(redactLog('cookie: session=abcdef'), 'cookie: [secret]');
    assert.equal(redactLog('set-cookie: sid=deadbeef'), 'set-cookie: [secret]');
    assert.equal(
      redactLog('{"authorization": "Basic dXNlcjpwYXNz"}'),
      '{"authorization": "[secret]"}',
    );
  });

  test('проза с «cookie:» не маскируется (#246)', () => {
    assert.equal(
      redactLog('cookie: проверяется только в production'),
      'cookie: проверяется только в production',
    );
    assert.equal(
      redactLog('set-cookie: ставится один раз при входе'),
      'set-cookie: ставится один раз при входе',
    );
    assert.equal(
      redactLog('authorization: проверяется только в production'),
      'authorization: проверяется только в production',
    );
  });

  test('сырой токен в authorization машинного вида маскируется', () => {
    assert.equal(redactLog('authorization: abc123def456ghi789'), 'authorization: [secret]');
  });

  test('JWT заменяется на [secret]', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';

    assert.equal(redactLog(`токен ${token} в заголовке`), 'токен [secret] в заголовке');
  });

  test('строка подключения Postgres теряет пароль', () => {
    assert.equal(
      redactLog('DATABASE_URL=postgresql://app:s3cr3t@127.0.0.1:5432/hair_lab'),
      'DATABASE_URL=postgresql://[secret]@127.0.0.1:5432/hair_lab',
    );
    assert.equal(
      redactLog('postgres://app:s3cr3t@db:5432/hair_lab'),
      'postgresql://[secret]@db:5432/hair_lab',
    );
  });

  test('значение после key/token/secret/password/passwd/pwd от 8 символов — [secret]', () => {
    assert.equal(redactLog('password=abcdefgh'), 'password=[secret]');
    assert.equal(redactLog('api_key: "abcdefgh12"'), 'api_key: "[secret]"');
    assert.equal(redactLog('pwd: abcdefgh'), 'pwd: [secret]');
    assert.equal(redactLog('passwd=abcdefgh'), 'passwd=[secret]');
  });

  test('короткое значение после ключа не маскируется', () => {
    assert.equal(redactLog('pwd=abc'), 'pwd=abc');
  });
});

describe('redactLog: границы', () => {
  test('хэш коммита (40 hex) не маскируется', () => {
    const hash = '0123456789abcdef0123456789abcdef01234567';

    assert.equal(redactLog(`commit ${hash}`), `commit ${hash}`);
  });

  test('UUID не маскируется', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';

    assert.equal(redactLog(`id ${uuid}`), `id ${uuid}`);
  });

  test('номера строк не маскируются', () => {
    assert.equal(redactLog('scripts/lib/cycle/refs.mjs:12'), 'scripts/lib/cycle/refs.mjs:12');
    assert.equal(redactLog('review.md:12:34'), 'review.md:12:34');
  });

  test('часовой пояс в ISO-времени не принимается за телефон', () => {
    assert.equal(
      redactLog('started_at 2026-11-16T09:00:00+03:00'),
      'started_at 2026-11-16T09:00:00+03:00',
    );
    assert.equal(redactLog('+03'), '+03');
  });

  test('число строк не меняется: переводы строк не склеиваются и не теряются', () => {
    const text = ['first user@example.com', '+79990000000', 'password=abcdefgh', 'tail'].join('\n');

    const redacted = redactLog(text);

    assert.equal(redacted.split('\n').length, 4);
    assert.equal(redacted, ['first [email]', '[phone]', 'password=[secret]', 'tail'].join('\n'));
  });

  test('пустая строка остаётся пустой', () => {
    assert.equal(redactLog(''), '');
  });
});

describe('redactPatch', () => {
  test('маскирует контакты, JWT и пароль строки подключения', () => {
    assert.equal(redactPatch('contact user@example.com +79990000000'), 'contact [email] [phone]');
    assert.equal(
      redactPatch(
        'const header = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl";',
      ),
      'const header = "Authorization: Bearer [secret]";',
    );
    assert.equal(
      redactPatch('DATABASE_URL=postgresql://app:s3cr3t@127.0.0.1:5432/hair_lab'),
      'DATABASE_URL=postgresql://[secret]@127.0.0.1:5432/hair_lab',
    );
  });

  test('не трогает код справа от ключей — патч остаётся кодом (#246)', () => {
    const code = [
      'async function createSessionToken(): Promise<void> {',
      '  const token = request.cookies[STAFF_SESSION_COOKIE_NAME];',
      '  if (typeof value === "string") return;',
      '  // cookie: проверяется только в production',
    ].join('\n');

    assert.equal(redactPatch(code), code);
  });

  test('не строка — исключение', () => {
    assert.throws(() => redactPatch(null), /ожидается строка/);
  });
});

describe('redactQa', () => {
  test('маскирует строковые значения, сохраняя структуру и id шагов', () => {
    const qa = fixture('qa-web.valid.json');
    qa.steps[0].observed = 'Клиент user@example.com, +79990000000, token=abcdefgh';

    const redacted = redactQa(qa);

    assert.equal(redacted.steps.length, qa.steps.length);
    assert.equal(redacted.steps[0].id, 's1');
    assert.equal(redacted.steps[1].id, 's2');
    assert.equal(redacted.steps[0].observed, 'Клиент [email], [phone], token=[secret]');
    assert.deepEqual(redacted.steps[1].console_errors, qa.steps[1].console_errors);
    assert.deepEqual(redacted.steps[1].cache_headers, { 'cache-control': 'no-store' });
  });

  test('массив console_errors остаётся того же размера', () => {
    const qa = {
      status: 'done',
      reason: null,
      steps: [
        {
          id: 's1',
          url: 'http://127.0.0.1:3003/booking',
          action: 'Открыть',
          observed: 'ok',
          console_errors: ['ошибка user@example.com', 'вторая ошибка', 'третья'],
          failed_requests: [],
          cache_headers: null,
        },
      ],
    };

    const redacted = redactQa(qa);

    assert.equal(redacted.steps[0].console_errors.length, 3);
    assert.equal(redacted.steps[0].console_errors[0], 'ошибка [email]');
    assert.equal(redacted.steps[0].console_errors[2], 'третья');
  });

  test('не мутирует входной объект', () => {
    const qa = { steps: [{ id: 's1', observed: 'user@example.com' }] };

    redactQa(qa);

    assert.equal(qa.steps[0].observed, 'user@example.com');
  });

  test('не строковые значения не меняются', () => {
    const qa = { status: 'done', reason: null, steps: [], count: 42, ok: false };

    assert.deepEqual(redactQa(qa), {
      status: 'done',
      reason: null,
      steps: [],
      count: 42,
      ok: false,
    });
  });
});

describe('scanSecrets', () => {
  test('находит все образцы секретов из фикстуры', () => {
    const findings = scanSecrets(fixture('added-lines.secrets.json'));

    assert.deepEqual(findings, [
      { line: 2, kind: 'private_key' },
      { line: 3, kind: 'aws_access_key' },
      { line: 4, kind: 'jwt' },
      { line: 5, kind: 'postgres_password' },
      { line: 6, kind: 'assigned_secret' },
    ]);
  });

  test('не срабатывает на заглушках, хэшах, UUID и шаблонных значениях', () => {
    assert.deepEqual(scanSecrets(fixture('added-lines.clean.json')), []);
  });

  test('находка не содержит значения секрета', () => {
    const secret = 'Zx9-train-only-0000';
    const findings = scanSecrets([`PASSWORD="${secret}"`]);

    assert.deepEqual(findings, [{ line: 1, kind: 'assigned_secret' }]);
    assert.equal(JSON.stringify(findings).includes(secret), false);
  });

  test('присвоение короче 12 символов не считается секретом', () => {
    assert.deepEqual(scanSecrets(['password="short"', 'token=abc']), []);
  });

  test('значение с боевым секретом и словом example внутри — находка', () => {
    // Сценарий ревью: поиск заглушек по подстроке скрывал такие секреты.
    assert.deepEqual(scanSecrets(['api_key=prodexample12345678']), [
      { line: 1, kind: 'assigned_secret' },
    ]);
    assert.deepEqual(scanSecrets(['postgres://user:prodexample123@db:5432/hair_lab']), [
      { line: 1, kind: 'postgres_password' },
    ]);
  });

  test('заглушкой считается только значение целиком', () => {
    assert.deepEqual(
      scanSecrets([
        'token="example-token-value"',
        'secret="{{SECRET_VALUE}}"',
        'password="CHANGEME"',
        'api_key="xxxxxxxxxxxxxxxx"',
      ]),
      [],
    );
  });

  test('пароль Postgres-строки с шаблоном не считается секретом', () => {
    assert.deepEqual(scanSecrets(['postgres://user:{{DB_PASSWORD}}@db:5432/hair_lab']), []);
    assert.deepEqual(scanSecrets(['postgres://user:s3cr3tpass@db:5432/hair_lab']), [
      { line: 1, kind: 'postgres_password' },
    ]);
  });

  test('пустой массив — нет находок', () => {
    assert.deepEqual(scanSecrets([]), []);
  });

  test('не массив — исключение', () => {
    assert.throws(() => scanSecrets('password=abcdefghijkl'), /ожидается массив/);
  });
});
