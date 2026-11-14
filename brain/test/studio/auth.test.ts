import { describe, expect, it } from 'vitest';
import { checkHost, checkHostAndOrigin, checkRequest, randomToken, safeEq } from '../../src/studio/auth.js';

const T = 't'.repeat(40);
const h = (headers: Record<string, string>) => headers;
const isT = (t: string) => t === T;

describe('safeEq', () => {
  it('is true only for identical strings, false for differing lengths without leaking which', () => {
    expect(safeEq(T, T)).toBe(true);
    expect(safeEq(T, `${T}x`)).toBe(false);
    expect(safeEq(T, 'short')).toBe(false);
  });
});

describe('randomToken', () => {
  it('produces distinct hex strings of the requested entropy', () => {
    const a = randomToken(32);
    const b = randomToken(32);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(randomToken(16)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('checkHost', () => {
  it('accepts only the exact loopback host', () => {
    expect(checkHost(h({ host: '127.0.0.1:5000' }), 5000)).toEqual({ ok: true });
    expect(checkHost(h({ host: 'evil.test:5000' }), 5000)).toEqual({ ok: false, status: 403, reason: 'bad_host' });
    expect(checkHost(h({ host: 'localhost:5000' }), 5000)).toMatchObject({ reason: 'bad_host' });
    expect(checkHost(h({}), 5000)).toMatchObject({ reason: 'bad_host' });
  });
});

describe('checkHostAndOrigin', () => {
  it('accepts a matching host with no Origin, or an exact-matching Origin', () => {
    expect(checkHostAndOrigin(h({ host: '127.0.0.1:5000' }), 5000)).toEqual({ ok: true });
    expect(checkHostAndOrigin(h({ host: '127.0.0.1:5000', origin: 'http://127.0.0.1:5000' }), 5000)).toEqual({ ok: true });
  });
  it('rejects a foreign Origin (CSRF)', () => {
    expect(checkHostAndOrigin(h({ host: '127.0.0.1:5000', origin: 'http://evil.test' }), 5000)).toEqual({ ok: false, status: 403, reason: 'bad_origin' });
  });
  it('rejects a foreign Host before even looking at Origin', () => {
    expect(checkHostAndOrigin(h({ host: 'evil.test:5000', origin: 'http://127.0.0.1:5000' }), 5000)).toEqual({ ok: false, status: 403, reason: 'bad_host' });
  });
});

describe('checkRequest', () => {
  it('accepts a valid bearer token with the exact loopback Host', () => {
    expect(checkRequest(h({ host: '127.0.0.1:5000', authorization: `Bearer ${T}` }), 5000, isT)).toEqual({ ok: true });
  });
  it('rejects a foreign Host (DNS rebinding) even with a valid token', () => {
    expect(checkRequest(h({ host: 'evil.test:5000', authorization: `Bearer ${T}` }), 5000, isT)).toEqual({ ok: false, status: 403, reason: 'bad_host' });
  });
  it('rejects a foreign Origin (CSRF)', () => {
    expect(checkRequest(h({ host: '127.0.0.1:5000', origin: 'http://evil.test', authorization: `Bearer ${T}` }), 5000, isT)).toEqual({ ok: false, status: 403, reason: 'bad_origin' });
  });
  it('rejects missing or invalid tokens', () => {
    expect(checkRequest(h({ host: '127.0.0.1:5000' }), 5000, isT)).toEqual({ ok: false, status: 401, reason: 'no_token' });
    expect(checkRequest(h({ host: '127.0.0.1:5000', authorization: 'Bearer wrong' }), 5000, isT)).toMatchObject({ status: 401 });
  });
  it('never reads or expects a cookie — no cookie header influences the result either way', () => {
    expect(checkRequest(h({ host: '127.0.0.1:5000', cookie: `coco_studio=${T}` }), 5000, isT)).toEqual({ ok: false, status: 401, reason: 'no_token' });
  });
  it('accepts whatever token predicate the caller supplies (e.g. primary-or-session)', () => {
    const isEither = (t: string) => t === T || t === 'session-token';
    expect(checkRequest(h({ host: '127.0.0.1:5000', authorization: 'Bearer session-token' }), 5000, isEither)).toEqual({ ok: true });
  });
});
