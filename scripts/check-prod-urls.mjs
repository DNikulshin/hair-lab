#!/usr/bin/env node
/**
 * Проверка прод-адресов перед сборкой и деплоем (issue #142).
 *
 * На этом ПК стенды живут на внешнем `:8443` (обход домашнего NAT: 8443 → 443). В проде так быть
 * не должно: адреса идут без порта, только `https`. Ошибка здесь стоит дорого — `NEXT_PUBLIC_*`
 * вшивается в web-бандл при сборке, `APP_URL` уходит в письма, `CORS_ORIGINS` в заголовки,
 * `YOOKASSA_RETURN_URL` в платёжный шлюз, и исправлять это можно только пересборкой.
 *
 * Запускается шагом workflow `release.yml` в двух местах (перед сборкой образов и перед деплоем).
 * Значения читаются из окружения; пустые пропускаются (например, `YOOKASSA_RETURN_URL`
 * может не задаваться — тогда api использует свой дефолт).
 *
 * Проверки для каждого адреса:
 *   - схема `https://`;
 *   - нет нестандартного порта (`:8443` и любой другой; явный `:443` URL нормализует сам
 *     и он безопасен — это тот же дефолт);
 *   - хост не локальный (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`).
 */

const VARS = ['NEXT_PUBLIC_SITE_URL', 'APP_URL', 'CORS_ORIGINS', 'YOOKASSA_RETURN_URL'];

/** Порт, который использует этот хост для стендов (staging/preprod) — в проде его быть не должно. */
const STAND_PORT = '8443';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

const problems = [];

/** Проверяет один адрес; возвращает текст ошибки или null. */
function checkUrl(variable, raw, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return `${variable}: «${value}» — не URL`;
  }
  if (url.protocol !== 'https:') {
    return `${variable}: «${value}» — нужна схема https://`;
  }
  if (url.port) {
    const hint =
      url.port === STAND_PORT
        ? ` — ${STAND_PORT} это порт стенда на этом хосте (NAT), в проде адрес без порта`
        : ' — в проде порт в адресе не указывается';
    return `${variable}: «${value}» — явный порт :${url.port}${hint}`;
  }
  if (LOCAL_HOSTS.has(url.hostname)) {
    return `${variable}: «${value}» — локальный адрес, в проде нужен публичный домен`;
  }
  return null;
}

for (const variable of VARS) {
  const raw = process.env[variable];
  if (!raw || raw.trim() === '') continue;
  // CORS_ORIGINS — список через запятую.
  const values = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const value of values) {
    const problem = checkUrl(variable, raw, value);
    if (problem) problems.push(problem);
  }
}

if (problems.length > 0) {
  console.error('Прод-адреса не проходят проверку:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    'Правило: 8443 — только для стендов на этом хосте; прод слушает 443, порт в адресах не пишется.',
  );
  process.exit(1);
}

const checked = VARS.filter((variable) => process.env[variable]?.trim()).length;
console.log(`Прод-адреса в порядке (проверено переменных: ${checked}).`);
