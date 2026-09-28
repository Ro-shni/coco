import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorManager } from '../../src/connectors/manager.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import { MemorySecretStore, secretKey } from '../../src/connectors/secrets.js';
import type { ServerConfig } from '../../src/connectors/types.js';
import { silentLogger } from '../../src/logger.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'mcp-server.mjs');
const fixtureCfg = (over: Partial<ServerConfig> = {}): ServerConfig => ({
  id: 'fx', name: 'fixture', transport: 'stdio', command: process.execPath, args: [FIXTURE],
  envSecrets: ['FIXTURE_SECRET'], headerSecrets: [], auth: 'none', enabled: true, source: 'custom', readOnly: false, ...over,
});

let managers: ConnectorManager[] = [];
afterEach(async () => {
  await Promise.all(managers.map((m) => m.closeAll()));
  managers = [];
});

async function setup(cfg = fixtureCfg(), opts: { callTimeoutMs?: number } = {}) {
  const registry = new ConnectorRegistry(mkdtempSync(join(tmpdir(), 'coco-mgr-')));
  registry.upsert(cfg);
  const secrets = new MemorySecretStore();
  await secrets.set(secretKey(cfg.id, 'FIXTURE_SECRET'), 's3cr3t');
  let now = 1_000_000;
  const m = new ConnectorManager({ registry, secrets, clock: () => now, log: silentLogger, callTimeoutMs: opts.callTimeoutMs ?? 20_000 });
  managers.push(m);
  return { m, registry, advance: (ms: number) => (now += ms) };
}

describe('ConnectorManager (real stdio fixture)', () => {
  it('starts disconnected, connects lazily and lists qualified tools', async () => {
    const { m } = await setup();
    expect(m.statuses()).toEqual([{ id: 'fx', state: 'disconnected', toolCount: 0, since: 1_000_000 }]);
    const st = await m.ensureConnected('fx');
    expect(st.state).toBe('connected');
    expect(m.tools().map((t) => t.qualified).sort()).toEqual(['fx__crash', 'fx__echo', 'fx__hang']);
    expect(m.tools().find((t) => t.name === 'echo')!.inputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } });
  });

  it('passes Keychain env secrets to the child and returns flattened text', async () => {
    const { m } = await setup();
    const r = await m.callTool('fx__echo', { text: 'hi' });
    expect(r).toMatchObject({ ok: true, text: 'echo:hi:s3cr3t' });
  });

  it('times out a hung tool call without stalling', async () => {
    const { m } = await setup(fixtureCfg(), { callTimeoutMs: 300 });
    const started = Date.now();
    const r = await m.callTool('fx__hang', {});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('marks a crashed server as error and drops its tools', async () => {
    const { m } = await setup();
    await m.ensureConnected('fx');
    const r = await m.callTool('fx__crash', {});
    expect(r.ok).toBe(false);
    await new Promise((res) => setTimeout(res, 500));
    expect(m.statuses()[0]!.state).toBe('error');
    expect(m.tools()).toEqual([]);
  });

  it('backs off after a failed connect and retries after 30 s', async () => {
    const { m, advance } = await setup(fixtureCfg({ command: '/nonexistent/binary' }));
    expect((await m.ensureConnected('fx')).state).toBe('error');
    const again = await m.ensureConnected('fx'); // within back-off: no new attempt
    expect(again.state).toBe('error');
    advance(31_000);
    expect((await m.ensureConnected('fx')).state).toBe('error'); // retried (still failing), no throw
  });

  it('does not connect disabled servers and rejects unknown tools', async () => {
    const { m } = await setup(fixtureCfg({ enabled: false }));
    expect((await m.ensureConnected('fx')).state).toBe('disabled');
    expect(await m.callTool('nope__x', {})).toMatchObject({ ok: false, text: 'unknown tool nope__x' });
  });

  it('truncates long results to 4000 chars', async () => {
    const { m } = await setup();
    const r = await m.callTool('fx__echo', { text: 'x'.repeat(9000) });
    expect(r.text.length).toBeLessThanOrEqual(4000);
    expect(r.text.endsWith('…[truncated]')).toBe(true);
  });
});
