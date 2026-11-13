import { proxyToApi } from '@/shared/api/route-proxy';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return proxyToApi('/auth/logout', { method: 'POST' }, request);
}
