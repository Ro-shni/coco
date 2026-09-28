import { timingSafeEqual } from 'node:crypto';

export const COOKIE = 'coco_studio';
type Headers = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieToken(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return undefined;
}

export function checkRequest(req: { headers: Headers }, token: string, port: number):
  { ok: true } | { ok: false; status: 401 | 403; reason: 'bad_host' | 'bad_origin' | 'no_token' } {
  const host = one(req.headers.host);
  if (host !== `127.0.0.1:${port}`) return { ok: false, status: 403, reason: 'bad_host' };
  const origin = one(req.headers.origin);
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}`) return { ok: false, status: 403, reason: 'bad_origin' };
  const auth = one(req.headers.authorization);
  const given = auth?.startsWith('Bearer ') ? auth.slice(7) : cookieToken(one(req.headers.cookie));
  if (!given || !safeEq(given, token)) return { ok: false, status: 401, reason: 'no_token' };
  return { ok: true };
}

export const launchCookie = (token: string): string => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
