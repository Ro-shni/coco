import { describe, expect, it } from 'vitest';
import { checkRequest, launchCookie } from '../../src/studio/auth.js';

const T = 't'.repeat(40);
const h = (headers: Record<string, string>) => ({ headers });

describe('checkRequest', () => {
  it('accepts a matching cookie with the exact loopback Host', () => {
    expect(checkRequest(h({ host: '127.0.0.1:5000', cookie: `coco_studio=${T}` }), T, 5000)).toEqual({ ok: true });
  });
  it('accepts a bearer token', () => {
    expect(checkRequest(h({ host: '127.0.0.1:5000', authorization: `Bearer ${T}` }), T, 5000)).toEqual({ ok: true });
  });
  it('rejects a foreign Host (DNS rebinding) even with a valid cookie', () => {
    expect(checkRequest(h({ host: 'evil.test:5000', cookie: `coco_studio=${T}` }), T, 5000)).toEqual({ ok: false, status: 403, reason: 'bad_host' });
    expect(checkRequest(h({ host: 'localhost:5000', cookie: `coco_studio=${T}` }), T, 5000)).toMatchObject({ reason: 'bad_host' });
  });
  it('rejects a foreign Origin (CSRF)', () => {
    expect(checkRequest(h({ host: '127.0.0.1:5000', origin: 'http://evil.test', cookie: `coco_studio=${T}` }), T, 5000)).toEqual({ ok: false, status: 403, reason: 'bad_origin' });
  });
  it('rejects missing or wrong tokens', () => {
    expect(checkRequest(h({ host: '127.0.0.1:5000' }), T, 5000)).toEqual({ ok: false, status: 401, reason: 'no_token' });
    expect(checkRequest(h({ host: '127.0.0.1:5000', cookie: 'coco_studio=wrong' }), T, 5000)).toMatchObject({ status: 401 });
  });
  it('builds an HttpOnly SameSite=Strict cookie', () => {
    expect(launchCookie(T)).toBe(`coco_studio=${T}; HttpOnly; SameSite=Strict; Path=/`);
  });
});
