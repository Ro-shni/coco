import { afterEach, describe, expect, it } from 'vitest';
import { startOAuthCallbackServer, type OAuthCallbackServer } from '../../src/connectors/oauthCallbackServer.js';
import { silentLogger } from '../../src/logger.js';

let server: OAuthCallbackServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

describe('OAuth callback server', () => {
  it('serves only GET /oauth/callback on 127.0.0.1 and passes the query through', async () => {
    const seen: string[] = [];
    server = await startOAuthCallbackServer({ port: 0, log: silentLogger, handle: async (q) => { seen.push(q.get('state') ?? ''); return { status: 200, html: '<p>ok</p>' }; } });
    const base = `http://127.0.0.1:${server.port}`;
    const ok = await fetch(`${base}/oauth/callback?code=c&state=s1`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('<p>ok</p>');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(seen).toEqual(['s1']);
    expect((await fetch(`${base}/studio/`)).status).toBe(404);
    expect((await fetch(`${base}/oauth/callback`, { method: 'POST' })).status).toBe(404);
  });

  it('rejects a foreign Host header (DNS rebinding)', async () => {
    server = await startOAuthCallbackServer({ port: 0, log: silentLogger, handle: async () => ({ status: 200, html: 'x' }) });
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server!.port, path: '/oauth/callback?state=s', headers: { host: 'evil.test' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('rejects when the port is already in use', async () => {
    server = await startOAuthCallbackServer({ port: 0, log: silentLogger, handle: async () => ({ status: 200, html: 'x' }) });
    await expect(startOAuthCallbackServer({ port: server.port, log: silentLogger, handle: async () => ({ status: 200, html: 'x' }) })).rejects.toThrow(/in use/);
  });

  it('answers 500 (not a crash) when the handler throws', async () => {
    server = await startOAuthCallbackServer({ port: 0, log: silentLogger, handle: async () => { throw new Error('boom'); } });
    expect((await fetch(`http://127.0.0.1:${server.port}/oauth/callback?state=s`)).status).toBe(500);
  });
});
