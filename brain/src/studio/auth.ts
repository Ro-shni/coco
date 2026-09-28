import { randomBytes, timingSafeEqual } from 'node:crypto';

type Headers = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** Constant-time string equality, length-guarded (unequal lengths are rejected without comparing bytes). */
export function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A fresh random token/nonce, hex-encoded. `bytes` is the entropy in bytes (32 -> 64 hex chars). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('hex');

export function bearerToken(headers: Headers): string | undefined {
  const auth = one(headers.authorization);
  return auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

type HostFailure = { ok: false; status: 403; reason: 'bad_host' };
type OriginFailure = { ok: false; status: 403; reason: 'bad_origin' };
type TokenFailure = { ok: false; status: 401; reason: 'no_token' };
export type AuthResult = { ok: true } | HostFailure | OriginFailure | TokenFailure;

/** Host must be exactly 127.0.0.1:<port> — the DNS-rebinding gate. */
export function checkHost(headers: Headers, port: number): { ok: true } | HostFailure {
  return one(headers.host) === `127.0.0.1:${port}` ? { ok: true } : { ok: false, status: 403, reason: 'bad_host' };
}

/** Host must match, and Origin (when present) must be exactly http://127.0.0.1:<port> — the CSRF gate. */
export function checkHostAndOrigin(headers: Headers, port: number): { ok: true } | HostFailure | OriginFailure {
  const host = checkHost(headers, port);
  if (!host.ok) return host;
  const origin = one(headers.origin);
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}`) return { ok: false, status: 403, reason: 'bad_origin' };
  return { ok: true };
}

/**
 * Full /api/* gate: exact Host, exact-or-absent Origin, and a Bearer token accepted by `isValidToken`
 * (the caller decides what counts as valid — the permanent Studio token, a live session token, or both).
 * No cookies are read or set anywhere in this module.
 */
export function checkRequest(headers: Headers, port: number, isValidToken: (token: string) => boolean): AuthResult {
  const hostOrigin = checkHostAndOrigin(headers, port);
  if (!hostOrigin.ok) return hostOrigin;
  const token = bearerToken(headers);
  if (!token || !isValidToken(token)) return { ok: false, status: 401, reason: 'no_token' };
  return { ok: true };
}
