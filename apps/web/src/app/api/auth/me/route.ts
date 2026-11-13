import { proxyToApi } from '@/shared/api/route-proxy';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return proxyToApi('/auth/me', {}, request);
}
