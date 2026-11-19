#!/usr/bin/env node
/**
 * Заглушка API ЮKassa для браузерных тестов (issue #114).
 *
 * Зачем: сценарий оплаты должен проверяться в CI, но настоящий провайдер в пайплайне
 * недоступен. Прод-код не меняется: `YOOKASSA_API_URL` и раньше настраивался окружением,
 * поэтому заглушка подставляется этой переменной (см. `scripts/e2e.mjs`).
 *
 * Почему HTTPS: контракт ответа записи проверяет `confirmationUrl` как `https`-ссылку
 * (`packages/contracts`: `pattern: ^https$`) — клиента нельзя уводить на http. Поэтому заглушка
 * поднимает TLS с самоподписанным сертификатом, а Playwright ходит с `ignoreHTTPSErrors`.
 * Сертификат генерируется при старте через `openssl` (1 день, CN=127.0.0.1) во временный каталог:
 * приватный ключ в репозиторий не попадает.
 *
 * Что умеет (ровно то, что использует клиент `apps/api/src/features/payments/yookassa.client.ts`):
 * - `POST /v3/payments` — создание платежа: отдаёт `id`, `status: pending` и `confirmation_url`
 *   на собственную HTML-страницу «оплатить»;
 * - `GET /v3/payments/:id` — статус; `succeeded` после того, как страница оплаты нажала кнопку;
 * - `POST /v3/refunds` — возврат: сразу `succeeded`;
 * - `GET /pay/:id` — страница оплаты (то, куда попадает клиент из `confirmation_url`);
 * - `POST /pay/:id` — «оплатить»: переводит платёж в `succeeded`.
 *
 * Idempotence-Key и данные карты не проверяются: заглушка не эмулирует провайдера,
 * а даёт детерминированный ответ для сценария «клиент оплатил».
 *
 * Запуск: `node e2e/yookassa-stub.mjs [--port 3999]`. Печатает `stub: listening …`;
 * завершается по SIGTERM/SIGINT (родитель гасит процесс в teardown).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const portArgIndex = process.argv.indexOf('--port');
const port = Number(portArgIndex === -1 ? 3999 : process.argv[portArgIndex + 1]);

/** Базовый адрес заглушки: TLS обязателен, см. шапку файла. */
const baseUrl = `https://127.0.0.1:${port}`;

/** @type {Map<string, { id: string, status: string, amount: { value: string, currency: string }, paid: boolean }>} */
const payments = new Map();
let counter = 0;

/**
 * Тело запроса как JSON.
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<any>}
 */
async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  return body === '' ? {} : JSON.parse(body);
}

/** @param {import('node:http').ServerResponse} response */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    // Клиент ЮKassa ждёт идемпотентность по своему ключу: повтор вернёт тот же платёж.
  });
  response.end(body);
}

/** Платёж в форме ответа ЮKassa. */
function toDto(payment) {
  return {
    id: payment.id,
    status: payment.paid ? 'succeeded' : 'pending',
    paid: payment.paid,
    amount: payment.amount,
    confirmation: { type: 'redirect', confirmation_url: `${baseUrl}/pay/${payment.id}` },
    created_at: new Date(0).toISOString(),
  };
}

/**
 * Самоподписанный сертификат во временном каталоге: ключ живёт только на время стенда.
 * `E2E_TLS_DIR` позволяет стенду (`scripts/e2e.mjs`) узнать путь к `cert.pem` и передать его
 * api в `NODE_EXTRA_CA_CERTS`: тогда самоподписанный сертификат доверенный, и проверку TLS
 * в тестах отключать не нужно.
 * @returns {{ key: Buffer, cert: Buffer, dir: string }}
 */
function createCertificate() {
  const dir = process.env.E2E_TLS_DIR ?? mkdtempSync(join(tmpdir(), 'hair-lab-e2e-tls-'));
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      // SAN обязателен: по CN современный TLS не проверяет имя, и Node отклонил бы сертификат
      // с `ERR_TLS_CERT_ALTNAME_INVALID`.
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { stdio: 'ignore' },
  );
  if (result.status !== 0) {
    throw new Error('stub: не удалось создать сертификат (нужен openssl в PATH)');
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath), dir };
}

const certificate = createCertificate();

const server = createHttpsServer(
  { key: certificate.key, cert: certificate.cert },
  async (request, response) => {
    const url = new URL(request.url ?? '/', baseUrl);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/v3/payments') {
      const body = await readJson(request);
      const key = request.headers['idempotence-key'];
      const existing = typeof key === 'string' ? payments.get(key) : undefined;
      if (existing !== undefined) return sendJson(response, 200, toDto(existing));

      counter += 1;
      const payment = {
        id: `e2e-payment-${counter}`,
        amount: body.amount ?? { value: '0.00', currency: 'RUB' },
        paid: false,
      };
      if (typeof key === 'string') payments.set(key, payment);
      payments.set(payment.id, payment);
      return sendJson(response, 200, toDto(payment));
    }

    if (request.method === 'GET' && path.startsWith('/v3/payments/')) {
      const payment = payments.get(path.slice('/v3/payments/'.length));
      if (payment === undefined) return sendJson(response, 404, { description: 'not found' });
      return sendJson(response, 200, toDto(payment));
    }

    if (request.method === 'POST' && path === '/v3/refunds') {
      const body = await readJson(request);
      return sendJson(response, 200, {
        id: `e2e-refund-${body.payment_id ?? 'unknown'}`,
        status: 'succeeded',
        amount: body.amount ?? { value: '0.00', currency: 'RUB' },
      });
    }

    // Страница оплаты: клиент попадает сюда по `confirmation_url`.
    const payMatch = /^\/pay\/(.+)$/u.exec(path);
    if (payMatch !== null) {
      const id = decodeURIComponent(payMatch[1]);
      const payment = payments.get(id);
      if (payment === undefined) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return response.end('Платёж не найден');
      }

      if (request.method === 'POST') {
        payment.paid = true;
        response.writeHead(303, { location: `/pay/${id}` });
        return response.end();
      }

      const state = payment.paid ? 'Оплачено' : 'Ждёт оплаты';
      const body = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>E2E оплата</title></head>
<body style="font-family:sans-serif;padding:24px">
<h1 data-testid="stub-status">${state}</h1>
<form method="post" action="/pay/${id}"><button type="submit">Оплатить</button></form>
</body></html>`;
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      return response.end(body);
    }

    sendJson(response, 404, { description: 'not found' });
  },
);

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`stub: listening on ${baseUrl}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () =>
    server.close(() => {
      rmSync(certificate.dir, { recursive: true, force: true });
      process.exit(0);
    }),
  );
}
