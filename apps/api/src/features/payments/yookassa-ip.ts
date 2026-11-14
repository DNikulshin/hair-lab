/**
 * Allowlist IP-адресов, с которых ЮKassa присылает HTTP-уведомления.
 *
 * Источник: https://yookassa.ru/developers/using-api/webhooks — раздел о проверке IP-адреса
 * отправителя. Список закрытый и меняется провайдером, поэтому он живёт константой в коде,
 * а не в окружении: настройка «на всякий случай разрешить всё» не должна появляться молча.
 *
 * Функция чистая (без сети и БД): проверяется адрес из запроса, и только он. Прокси
 * (`trustProxy`) уже нормализовал `request.ip`, поэтому здесь ничего не разбирается из заголовков.
 */

/** IPv4-подсети уведомлений. */
const YOOKASSA_IPV4_RANGES: ReadonlyArray<{ network: readonly number[]; prefix: number }> = [
  { network: [185, 71, 76, 0], prefix: 27 },
  { network: [185, 71, 77, 0], prefix: 27 },
  { network: [77, 75, 153, 0], prefix: 25 },
  { network: [77, 75, 154, 128], prefix: 25 },
];

/** Одиночные IPv4-адреса из того же allowlist. */
const YOOKASSA_IPV4_EXACT: readonly string[] = ['77.75.156.11', '77.75.156.35'];

/** IPv6-подсеть уведомлений: `2a02:5180::/32` — первые два hextet'а (32 бита). */
const YOOKASSA_IPV6_HEXTETS: readonly number[] = [0x2a02, 0x5180];

const IPV4_OCTET = /^\d{1,3}$/;
const IPV6_HEXTET = /^[0-9a-f]{1,4}$/i;

/** IPv4 → 32-битное число. `null` — это не адрес (или адрес с недопустимым октетом). */
function parseIpv4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    if (!IPV4_OCTET.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
}

/** IPv6 (без зоны) → 8 hextet'ов. `null` — это не адрес. */
function parseIpv6(value: string): number[] | null {
  if (!value.includes(':')) return null;

  const halves = value.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (part: string | undefined): number[] | null => {
    if (part === undefined || part === '') return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!IPV6_HEXTET.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0]);
  const tail = parseGroups(halves[1]);
  if (head === null || tail === null) return null;

  // Без `::` адрес должен быть полным: восемь групп, иначе это не IPv6.
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 0 : fill !== 0) return null;

  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * IPv4 внутри IPv6 (`::ffff:185.71.76.5` и его hex-форма `::ffff:b947:4c05`).
 * За прокси настоящий адрес клиента может прийти именно в такой записи.
 */
function embeddedIpv4Of(value: string): number | null {
  const mapped = value.toLowerCase();
  if (!mapped.startsWith('::ffff:')) return null;

  const rest = mapped.slice('::ffff:'.length);
  if (rest.includes('.')) return parseIpv4(rest);

  const groups = parseIpv6(mapped);
  if (groups === null || groups.length !== 8) return null;
  const [a, b, c, d, e, f, g, h] = groups;
  if (a !== 0 || b !== 0 || c !== 0 || d !== 0 || e !== 0 || f !== 0xffff) return null;
  return (g ?? 0) * 0x10000 + (h ?? 0);
}

/**
 * Нормализация адреса из запроса: пробелы, скобки `[::1]`, зона `%eth0`, нижний регистр.
 * `null` — пустое или неразбираемое значение (не адрес).
 */
function normalizeIp(raw: string): string | null {
  let value = raw.trim();
  if (value === '') return null;

  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return null;
    value = value.slice(1, end);
  }

  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);

  value = value.toLowerCase();
  return value === '' ? null : value;
}

/** IPv4-адрес в 32-битном виде: напрямую или из IPv4-mapped IPv6. */
function ipv4Of(address: string): number | null {
  if (!address.includes(':')) return parseIpv4(address);

  const embedded = embeddedIpv4Of(address);
  if (embedded !== null) return embedded;

  return null;
}

function inIpv4Range(ip: number, network: readonly number[], prefix: number): boolean {
  let networkValue = 0;
  for (const octet of network) networkValue = networkValue * 256 + octet;

  // Маска в беззнаковом 32-битном виде: `0xffffffff << 5` в JS — знаковое число.
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) >>> 0 === (networkValue & mask) >>> 0;
}

/** 32-битное число → точечная запись IPv4 (для сравнения с точным списком). */
function formatIpv4(value: number): string {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(
    '.',
  );
}

/**
 * Пришёл ли запрос с адреса уведомлений ЮKassa.
 *
 * `false` для мусора, пустой строки, `localhost`, приватных сетей и любых адресов вне
 * allowlist: сомнительный адрес не должен проходить проверку. IPv4-mapped IPv6
 * (`::ffff:185.71.76.5`) сравнивается как IPv4.
 */
export function isYookassaIp(ip: string): boolean {
  const address = normalizeIp(ip);
  if (address === null) return false;

  const ipv4 = ipv4Of(address);
  if (ipv4 !== null) {
    if (YOOKASSA_IPV4_EXACT.includes(formatIpv4(ipv4))) return true;
    return YOOKASSA_IPV4_RANGES.some((range) => inIpv4Range(ipv4, range.network, range.prefix));
  }

  const groups = parseIpv6(address);
  if (groups === null) return false;

  return groups[0] === YOOKASSA_IPV6_HEXTETS[0] && groups[1] === YOOKASSA_IPV6_HEXTETS[1];
}
