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
