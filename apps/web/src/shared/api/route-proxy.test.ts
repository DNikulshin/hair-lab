import { afterEach, describe, expect, it, vi } from 'vitest';
import { proxyToApi } from './route-proxy';

afterEach(() => vi.unstubAllGlobals());

describe('proxyToApi auth forwarding', () => {
  it('forwards browser Cookie and Origin and relays Set-Cookie without caching', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ client: { id: 'client-id' } }), {
        status: 201,
        headers: {
          'Content-Type': 'application/json',
          'Set-Cookie': 'hl_session=opaque; Path=/; HttpOnly; SameSite=Lax',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const request = new Request('http://localhost:3000/api/auth/register', {
      method: 'POST',
      headers: {
        Cookie: 'hl_session=incoming',
        Origin: 'http://localhost:3000',
        Referer: 'http://localhost:3000/register',
      },
    });
    const response = await proxyToApi(
      '/auth/register',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      request,
    );

    const upstreamInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(upstreamInit.headers);
    expect(headers.get('cookie')).toBe('hl_session=incoming');
    expect(headers.get('origin')).toBe('http://localhost:3000');
    expect(headers.get('referer')).toBe('http://localhost:3000/register');
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toContain('hl_session=opaque');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ client: { id: 'client-id' } });
  });
});

describe('proxyToApi client address forwarding', () => {
  /**
   * Заголовки с CR/LF нельзя собрать через `Headers` (он отвергает такие значения), поэтому
   * в этих тестах хватает запроса-заглушки: `proxyToApi` читает только `headers.get`.
   */
  const requestWithRawHeaders = (values: Record<string, string>): Request =>
    ({ headers: { get: (name: string) => values[name.toLowerCase()] ?? null } }) as Request;

  const mockUpstream = (): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  const upstreamHeaders = (fetchMock: ReturnType<typeof vi.fn>): Headers =>
    new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);

  it('forwards x-forwarded-for from the incoming request', async () => {
    const fetchMock = mockUpstream();
    const request = new Request('http://localhost:3000/api/bookings', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '203.0.113.7' },
    });

    await proxyToApi('/bookings', { method: 'POST', body: '{}' }, request);

    expect(upstreamHeaders(fetchMock).get('x-forwarded-for')).toBe('203.0.113.7');
  });

  it.each(['203.0.113.7', '::1', '2001:db8::8a2e:370:7334', '::ffff:192.0.2.1'])(
    'forwards valid single address (%s)',
    async (value) => {
      const fetchMock = mockUpstream();
      const request = new Request('http://localhost:3000/api/bookings', {
        method: 'POST',
        headers: { 'X-Forwarded-For': value },
      });

      await proxyToApi('/bookings', { method: 'POST', body: '{}' }, request);

      expect(upstreamHeaders(fetchMock).get('x-forwarded-for')).toBe(value);
    },
  );

  it('falls back to x-real-ip when x-forwarded-for is absent', async () => {
    const fetchMock = mockUpstream();
    const request = new Request('http://localhost:3000/api/bookings', {
      method: 'POST',
      headers: { 'X-Real-IP': '2001:db8::1' },
    });

    await proxyToApi('/bookings', { method: 'POST', body: '{}' }, request);

    expect(upstreamHeaders(fetchMock).get('x-forwarded-for')).toBe('2001:db8::1');
  });

  it.each([
    ['newline injection', '203.0.113.7\nX-Evil: 1'],
    ['list of addresses', '203.0.113.7, 198.51.100.9'],
    ['space separated addresses', '203.0.113.7 198.51.100.9'],
    ['garbage', 'not-an-ip'],
    ['too long for ipv6', 'fe80::1'.padEnd(46, '0')],
    ['only colons', '::::'],
    ['extra ipv4 octet', '1.2.3.4.5'],
    ['octet out of range', '999.1.1.1'],
    ['letters and a dot', 'ab.cd'],
    ['short ipv4', '1.2.3'],
    ['triple colon in ipv6', '2001:db8:::1'],
    ['ipv6 group longer than 4 hex', '2001:db8:12345::'],
  ])('does not forward suspicious value (%s) and keeps other headers', async (_label, value) => {
    const fetchMock = mockUpstream();
    const request = requestWithRawHeaders({
      'x-forwarded-for': value,
      cookie: 'hl_session=incoming',
      origin: 'http://localhost:3000',
    });

    await proxyToApi('/bookings', { method: 'POST', body: '{}' }, request);

    const headers = upstreamHeaders(fetchMock);
    expect(headers.get('x-forwarded-for')).toBeNull();
    expect(headers.get('cookie')).toBe('hl_session=incoming');
    expect(headers.get('origin')).toBe('http://localhost:3000');
  });

  it('falls back to x-real-ip when x-forwarded-for is not a valid address', async () => {
    const fetchMock = mockUpstream();
    const request = requestWithRawHeaders({
      'x-forwarded-for': '1.2.3.4.5',
      'x-real-ip': '198.51.100.9',
    });

    await proxyToApi('/bookings', { method: 'POST', body: '{}' }, request);

    expect(upstreamHeaders(fetchMock).get('x-forwarded-for')).toBe('198.51.100.9');
  });

  it('adds no address header when both headers are absent', async () => {
    const fetchMock = mockUpstream();
    const request = new Request('http://localhost:3000/api/bookings', {
      method: 'POST',
      headers: { Cookie: 'hl_session=incoming' },
    });

    await proxyToApi('/bookings', { method: 'POST', body: '{}' }, request);

    const headers = upstreamHeaders(fetchMock);
    expect(headers.get('x-forwarded-for')).toBeNull();
    expect(headers.get('x-real-ip')).toBeNull();
    expect(headers.get('cookie')).toBe('hl_session=incoming');
  });
});
