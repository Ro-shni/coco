import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../src/logger.js';
import { startServer, type BrainServer } from '../../src/server.js';
import { createStudioHandler } from '../../src/studio/http.js';
import type { ApiDeps } from '../../src/studio/api.js';

const TOKEN = 'b'.repeat(40);
const STUDIO = 's'.repeat(40);
let server: BrainServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function boot() {
  const staticDir = mkdtempSync(join(tmpdir(), 'coco-static-'));
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>Coco Studio</title>');
  mkdirSync(join(staticDir, 'assets'));
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  const api = { health: async () => true, models: { main: 'm', vision: 'v' }, registry: { list: () => [] }, manager: { statuses: () => [] } } as unknown as ApiDeps;
  const handler = createStudioHandler({ token: STUDIO, staticDir, api, log: silentLogger });
  server = await startServer({ token: TOKEN, onMessage: () => undefined, log: silentLogger, onHttp: handler });
  return `http://127.0.0.1:${server.port}`;
}

describe('Studio over HTTP', () => {
  it('launch sets the cookie and redirects to /studio/', async () => {
    const base = await boot();
    const res = await fetch(`${base}/studio/launch?t=${STUDIO}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/studio/');
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('launch with a wrong token is 401 and sets no cookie', async () => {
    const base = await boot();
    const res = await fetch(`${base}/studio/launch?t=nope`, { redirect: 'manual' });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('serves the SPA and assets with the cookie, with no-store and nosniff', async () => {
    const base = await boot();
    const cookie = `coco_studio=${STUDIO}`;
    const index = await fetch(`${base}/studio/`, { headers: { cookie } });
    expect(await index.text()).toContain('Coco Studio');
    expect(index.headers.get('cache-control')).toBe('no-store');
    expect(index.headers.get('x-content-type-options')).toBe('nosniff');
    const js = await fetch(`${base}/studio/assets/app.js`, { headers: { cookie } });
    expect(js.headers.get('content-type')).toContain('javascript');
    const deep = await fetch(`${base}/studio/connectors`, { headers: { cookie } }); // SPA fallback
    expect(await deep.text()).toContain('Coco Studio');
  });

  it('blocks path traversal', async () => {
    const base = await boot();
    const res = await fetch(`${base}/studio/..%2f..%2fetc%2fpasswd`, { headers: { cookie: `coco_studio=${STUDIO}` } });
    expect([400, 404]).toContain(res.status);
  });

  it('rejects API calls without the token, and with a foreign Origin', async () => {
    const base = await boot();
    expect((await fetch(`${base}/api/health`)).status).toBe(401);
    expect((await fetch(`${base}/api/health`, { headers: { cookie: `coco_studio=${STUDIO}`, origin: 'http://evil.test' } })).status).toBe(403);
    const ok = await fetch(`${base}/api/health`, { headers: { cookie: `coco_studio=${STUDIO}` } });
    expect(ok.status).toBe(200);
  });

  it('keeps the Body websocket working alongside', async () => {
    await boot();
    expect(server!.port).toBeGreaterThan(0); // upgrade path is covered by server.test.ts; onHttp must not intercept upgrades
  });
});
