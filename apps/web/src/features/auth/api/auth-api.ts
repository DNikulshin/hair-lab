import {
  authResponseSchema,
  type AuthResponse,
  type LoginRequest,
  type RegisterRequest,
} from '@hair-lab/contracts';

export type AuthFailure = { kind: 'network' } | { kind: 'http'; status: number; body: unknown };
export type AuthResult = { ok: true; data: AuthResponse } | { ok: false; failure: AuthFailure };

async function submit(path: string, body: LoginRequest | RegisterRequest): Promise<AuthResult> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return { ok: false, failure: { kind: 'network' } };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.ok) {
    const parsed = authResponseSchema.safeParse(payload);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, failure: { kind: 'network' } };
  }
  return { ok: false, failure: { kind: 'http', status: response.status, body: payload } };
}

export function login(body: LoginRequest): Promise<AuthResult> {
  return submit('/api/auth/login', body);
}

export function register(body: RegisterRequest): Promise<AuthResult> {
  return submit('/api/auth/register', body);
}
