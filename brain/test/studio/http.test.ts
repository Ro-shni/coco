import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { silentLogger } from '../../src/logger.js';
import { startServer, type BrainServer } from '../../src/server.js';
import { createStudioHandler } from '../../src/studio/http.js';
import { MemorySessionStore } from '../../src/studio/sessions.js';
import type { ApiDeps } from '../../src/studio/api.js';

const TOKEN = 'b'.repeat(40);
let server: BrainServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

interface RawResponse { status: number; headers: Record<string, string | string[] | undefined>; text: string }

/** Raw node:http request — used wherever a test needs to send a Host/Origin header (or a malformed path) that
 * `fetch` won't let a client override or send as-is. */
function rawRequest(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function fakeApi(): ApiDeps {
  return {
    health: async () => true, models: { main: 'm', vision: 'v' },
    registry: { list: () => [] }, manager: { statuses: () => [] },
  } as unknown as ApiDeps;
}

async function boot(opts: {
  sessions?: MemorySessionStore;
  onMessage?: (m: unknown) => void;
  oauthCallback?: (q: URLSearchParams) => Promise<{ status: number; html: string }>;
} = {}) {
  const staticDir = mkdtempSync(join(tmpdir(), 'coco-static-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Coco Studio</title>');
  mkdirSync(join(staticDir, 'assets'));
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  const sessions = opts.sessions ?? new MemorySessionStore();
  const handler = createStudioHandler({
    token: TOKEN, staticDir, api: fakeApi(), log: silentLogger, sessions,
    ...(opts.oauthCallback ? { oauthCallback: opts.oauthCallback } : {}),
  });
  server = await startServer({ token: TOKEN, onMessage: opts.onMessage ?? (() => undefined), log: silentLogger, onHttp: handler });
  return { base: `http://127.0.0.1:${server.port}`, port: server.port, sessions };
}

/** Mints a nonce with the primary token, then walks the launch page's own flow (POST the nonce to /studio/session)
 * to get a session token — exactly what the served page's inline script does. */
async function mintSession(base: string): Promise<string> {
  const nonceRes = await fetch(`${base}/api/launch-nonce`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  const sessionRes = await fetch(`${base}/studio/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  const { token } = (await sessionRes.json()) as { token: string };
  return token;
}

describe('Studio over HTTP', () => {
  describe('launch-nonce / launch / session flow (I1+I2)', () => {
    it('mints a one-time nonce only for the primary Studio token', async () => {
      const { base } = await boot();
      const wrong = await fetch(`${base}/api/launch-nonce`, { method: 'POST', headers: { authorization: 'Bearer wrong' } });
      expect(wrong.status).toBe(401);
      const missing = await fetch(`${base}/api/launch-nonce`, { method: 'POST' });
      expect(missing.status).toBe(401);
      const res = await fetch(`${base}/api/launch-nonce`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(200);
      const { nonce } = (await res.json()) as { nonce: string };
      expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    });

    it('a session token cannot mint further launch nonces', async () => {
      const { base } = await boot();
      const session = await mintSession(base);
      const res = await fetch(`${base}/api/launch-nonce`, { method: 'POST', headers: { authorization: `Bearer ${session}` } });
      expect(res.status).toBe(401);
    });

    it('/studio/launch renders for a well-formed nonce (Host-checked only), embedding it for its own script to consume', async () => {
      const { base } = await boot();
      const nonce = 'a'.repeat(64);
      const res = await fetch(`${base}/studio/launch?n=${nonce}`, { headers: {} });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('/studio/session');
      expect(text).toContain(nonce);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-security-policy')).toMatch(/script-src 'nonce-/);
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('content-security-policy')).toContain("form-action 'none'");
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('/studio/launch shows the "link expired" state for a missing or malformed nonce, without echoing it (N1)', async () => {
      const { base } = await boot();
      const res = await fetch(`${base}/studio/launch?n=${encodeURIComponent('<script>alert(1)</script>')}`, { headers: {} });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain('<script>alert');
      expect(text).not.toContain('/studio/session');
      expect(text.toLowerCase()).toContain('expired');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('content-security-policy')).toContain("form-action 'none'");

      const short = await fetch(`${base}/studio/launch?n=abc123`);
      expect((await short.text()).toLowerCase()).toContain('expired');
    });

    it('exchanging a valid nonce yields a session token that authorizes /api/*, no cookie involved', async () => {
      const { base } = await boot();
      const token = await mintSession(base);
      const res = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('a nonce is single-use', async () => {
      const { base } = await boot();
      const nonceRes = await fetch(`${base}/api/launch-nonce`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
      const { nonce } = (await nonceRes.json()) as { nonce: string };
      const first = await fetch(`${base}/studio/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
      expect(first.status).toBe(200);
      const second = await fetch(`${base}/studio/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
      expect(second.status).toBe(401);
    });

    it('an unknown or garbage nonce is rejected', async () => {
      const { base } = await boot();
      const res = await fetch(`${base}/studio/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: 'nope' }) });
      expect(res.status).toBe(401);
    });

    it('an expired nonce is rejected', async () => {
      let now = 0;
      const sessions = new MemorySessionStore(() => now);
      const { base } = await boot({ sessions });
      const nonce = sessions.createNonce();
      now += 61_000; // > 60s TTL
      const res = await fetch(`${base}/studio/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
      expect(res.status).toBe(401);
    });

    it('an expired session token no longer authorizes /api/*', async () => {
      let now = 0;
      const sessions = new MemorySessionStore(() => now);
      const { base } = await boot({ sessions });
      const token = sessions.consumeNonce(sessions.createNonce())!;
      expect((await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
      now += 12 * 60 * 60 * 1000 + 1; // > 12h TTL
      expect((await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    });

    it('the primary Studio token still authorizes /api/* directly (Body bypasses the browser flow)', async () => {
      const { base } = await boot();
      expect((await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    });
  });

  describe('Host / Origin enforcement', () => {
    it('rejects a foreign Host on /studio/launch, /studio/session, /api/*, and static files', async () => {
      const { port } = await boot();
      const launch = await rawRequest(port, '/studio/launch', { headers: { host: `evil.test:${port}` } });
      expect(launch.status).toBe(403);
      const session = await rawRequest(port, '/studio/session', { method: 'POST', headers: { host: `evil.test:${port}`, 'content-type': 'application/json' }, body: '{}' });
      expect(session.status).toBe(403);
      const api = await rawRequest(port, '/api/health', { headers: { host: `evil.test:${port}`, authorization: `Bearer ${TOKEN}` } });
      expect(api.status).toBe(403);
      const asset = await rawRequest(port, '/studio/', { headers: { host: `evil.test:${port}` } });
      expect(asset.status).toBe(403);
    });

    it('rejects a foreign Origin on /studio/session and /api/*, but static files ignore Origin', async () => {
      const { port } = await boot();
      const session = await rawRequest(port, '/studio/session', {
        method: 'POST', headers: { host: `127.0.0.1:${port}`, origin: 'http://evil.test', 'content-type': 'application/json' }, body: '{}',
      });
      expect(session.status).toBe(403);
      const api = await rawRequest(port, '/api/health', { headers: { host: `127.0.0.1:${port}`, origin: 'http://evil.test', authorization: `Bearer ${TOKEN}` } });
      expect(api.status).toBe(403);
      const asset = await rawRequest(port, '/studio/', { headers: { host: `127.0.0.1:${port}`, origin: 'http://evil.test' } });
      expect(asset.status).toBe(200);
    });
  });

  describe('static SPA serving', () => {
    it('serves static files and the SPA fallback without any token, Host check only', async () => {
      const { base } = await boot();
      const index = await fetch(`${base}/studio/`);
      expect(await index.text()).toContain('Coco Studio');
      expect(index.headers.get('cache-control')).toBe('no-store');
      expect(index.headers.get('x-content-type-options')).toBe('nosniff');
      const js = await fetch(`${base}/studio/assets/app.js`);
      expect(js.headers.get('content-type')).toContain('javascript');
      const deep = await fetch(`${base}/studio/connectors`); // SPA fallback
      expect(await deep.text()).toContain('Coco Studio');
    });

    it('blocks path traversal', async () => {
      const { base } = await boot();
      const res = await fetch(`${base}/studio/..%2f..%2fetc%2fpasswd`);
      expect([400, 404]).toContain(res.status);
    });

    it('blocks dotfile segments (M4)', async () => {
      const { base } = await boot();
      const res = await fetch(`${base}/studio/.env`);
      expect(res.status).toBe(404);
    });

    it('a malformed percent-escape in a static path is a 400 (M1)', async () => {
      const { port } = await boot();
      const res = await rawRequest(port, '/studio/%E4', { headers: { host: `127.0.0.1:${port}` } });
      expect(res.status).toBe(400);
    });
  });

  describe('/api/* auth and body handling', () => {
    it('rejects API calls without a token, and with a foreign Origin', async () => {
      const { base } = await boot();
      expect((await fetch(`${base}/api/health`)).status).toBe(401);
      expect((await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${TOKEN}`, origin: 'http://evil.test' } })).status).toBe(403);
      const ok = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(ok.status).toBe(200);
    });

    it('carries security headers on API responses', async () => {
      const { base } = await boot();
      const res = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    });

    it('rejects an oversize body with 413 and a JSON error, without resetting the connection (M2)', async () => {
      const { base } = await boot();
      const res = await fetch(`${base}/api/connectors`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: 'x'.repeat(300 * 1024),
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: 'body too large' });
    });

    it('rejects invalid JSON with 400', async () => {
      const { base } = await boot();
      const res = await fetch(`${base}/api/connectors`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{not json' });
      expect(res.status).toBe(400);
    });
  });

  describe('/oauth/callback (I5)', () => {
    it('runs the Host check before dispatching, and needs no token', async () => {
      const { base, port } = await boot({ oauthCallback: async () => ({ status: 200, html: '<p>ok</p>' }) });
      const foreign = await rawRequest(port, '/oauth/callback?code=x', { headers: { host: `evil.test:${port}` } });
      expect(foreign.status).toBe(403);
      const res = await fetch(`${base}/oauth/callback?code=x`); // no Authorization header at all
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('ok');
    });
  });

  describe('Body WebSocket alongside the Studio handler (I4)', () => {
    it('a correctly-authenticated Body connection still opens and exchanges messages', async () => {
      const received: unknown[] = [];
      const { port } = await boot({ onMessage: (m) => received.push(m) });
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      const incoming = new Promise<string>((resolve) => ws.once('message', (d) => resolve(d.toString())));
      ws.send(JSON.stringify({ v: 1, type: 'activity', state: 'idle', ts: 1 }));
      await new Promise((r) => setTimeout(r, 50));
      server!.send({ v: 1, type: 'mood', mood: 'bored' });
      expect(JSON.parse(await incoming)).toEqual({ v: 1, type: 'mood', mood: 'bored' });
      expect(received).toEqual([{ v: 1, type: 'activity', state: 'idle', ts: 1 }]);
      ws.close();
    });

    it('a Studio session token does not authorize the Body WebSocket upgrade', async () => {
      const { base, port } = await boot();
      const session = await mintSession(base);
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: `Bearer ${session}` } });
      await expect(new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      })).rejects.toThrow(/401/);
    });
  });
});
