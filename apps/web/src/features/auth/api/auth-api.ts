import {
  authResponseSchema,
  magicLinkConsumeSchema,
  magicLinkRequestSchema,
  okResponseSchema,
  type AuthResponse,
  type LoginRequest,
  type RegisterRequest,
} from '@hair-lab/contracts';
import { withBasePath } from '@/shared/config/api';

export type AuthFailure = { kind: 'network' } | { kind: 'http'; status: number; body: unknown };
export type AuthResult = { ok: true; data: AuthResponse } | { ok: false; failure: AuthFailure };
export type MagicLinkRequestResult = { ok: true } | { ok: false; failure: AuthFailure };

async function postJson(path: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(withBasePath(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return null;
  }
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function submitAuth(path: string, body: unknown): Promise<AuthResult> {
  const response = await postJson(path, body);
  if (response === null) return { ok: false, failure: { kind: 'network' } };
  const payload = await readPayload(response);
  if (response.ok) {
    const parsed = authResponseSchema.safeParse(payload);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, failure: { kind: 'network' } };
  }
  return { ok: false, failure: { kind: 'http', status: response.status, body: payload } };
}

export function login(body: LoginRequest): Promise<AuthResult> {
  return submitAuth('/api/auth/login', body);
}

export function register(body: RegisterRequest): Promise<AuthResult> {
  return submitAuth('/api/auth/register', body);
}

export async function requestMagicLink(email: string): Promise<MagicLinkRequestResult> {
  const parsed = magicLinkRequestSchema.safeParse({ email });
  if (!parsed.success) {
    return { ok: false, failure: { kind: 'http', status: 400, body: null } };
  }
  const response = await postJson('/api/auth/magic-link', parsed.data);
  if (response === null) return { ok: false, failure: { kind: 'network' } };
  const payload = await readPayload(response);
  if (response.ok && okResponseSchema.safeParse(payload).success) return { ok: true };
  return { ok: false, failure: { kind: 'http', status: response.status, body: payload } };
}

export function consumeMagicLink(token: string): Promise<AuthResult> {
  const parsed = magicLinkConsumeSchema.safeParse({ token });
  if (!parsed.success) {
    return Promise.resolve({ ok: false, failure: { kind: 'http', status: 401, body: null } });
  }
  return submitAuth('/api/auth/magic-link/consume', parsed.data);
}
