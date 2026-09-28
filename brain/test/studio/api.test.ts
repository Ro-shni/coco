import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../../src/agent/audit.js';
import type { ConnectorManager } from '../../src/connectors/manager.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import { MemorySecretStore, secretKey } from '../../src/connectors/secrets.js';
import { handleApi, type ApiDeps } from '../../src/studio/api.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'coco-api-'));
  const claudeJsonPath = join(root, 'claude.json');
  writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: {
    'kubectl-readonly': { type: 'stdio', command: '/usr/bin/python3', args: ['--read-only'], env: { KUBECONFIG: '/secret/path' } },
    bifrost: { type: 'http', url: 'http://ai-gateway.prd.meesho.int/mcp', headers: { Authorization: 'Bearer sk-SECRET' } },
  } }));
  const registry = new ConnectorRegistry(root);
  const secrets = new MemorySecretStore();
  const audit = new AuditLog(join(root, 'coco.db'));
  const manager = {
    statuses: () => registry.list().map((c) => ({ id: c.id, state: 'connected', toolCount: 1, since: 0 })),
    tools: () => registry.list().map((c) => ({ serverId: c.id, name: 'get_pods', qualified: `${c.id}__get_pods`, description: 'List pods', inputSchema: {} })),
    ensureConnected: vi.fn(async (id: string) => ({ id, state: 'connected', toolCount: 1, since: 0 })),
    disconnect: vi.fn(async () => undefined),
    callTool: vi.fn(async () => ({ ok: true, text: 'pods: a,b', ms: 3 })),
  } as unknown as ConnectorManager;
  const dirs: string[] = [];
  const deps: ApiDeps = {
    registry, manager, secrets, audit, health: async () => true, models: { main: 'qwen3.5:9b', vision: 'qwen3.5:9b' },
    claudeJsonPath, scanDirs: () => dirs, addScanDir: (d) => dirs.push(d), clock: () => 42,
  };
  const call = (method: string, path: string, body?: unknown, query = '') =>
    handleApi({ method, path, query: new URLSearchParams(query), body }, deps);
  return { call, registry, secrets, manager, audit, root };
}

describe('Studio API', () => {
  it('health summarises brain, ollama and connectors', async () => {
    const s = setup();
    expect((await s.call('GET', '/api/health')).json).toEqual({ brain: 'ok', ollama: true, models: { main: 'qwen3.5:9b', vision: 'qwen3.5:9b' }, connectors: { total: 0, connected: 0, error: 0 } });
  });

  it('discovery lists servers with names only — no secret values anywhere', async () => {
    const s = setup();
    const res = await s.call('GET', '/api/discovery');
    expect(JSON.stringify(res.json)).not.toMatch(/SECRET|\/secret\/path/);
    const list = (res.json as { servers: { name: string; status: string }[] }).servers;
    expect(list.find((x) => x.name === 'bifrost')!.status).toBe('blocked_host');
  });

  it('import requires confirm:true, stores secrets in the store (not the registry), and is idempotent', async () => {
    const s = setup();
    const key = ((await s.call('GET', '/api/discovery')).json as { servers: { name: string; key: string }[] }).servers.find((x) => x.name === 'kubectl-readonly')!.key;
    expect((await s.call('POST', '/api/discovery/import', { key })).status).toBe(400);
    const first = await s.call('POST', '/api/discovery/import', { key, confirm: true });
    expect(first).toEqual({ status: 200, json: { id: 'kubectl-readonly' } });
    expect(await s.secrets.get(secretKey('kubectl-readonly', 'KUBECONFIG'))).toBe('/secret/path');
    expect(JSON.stringify(s.registry.list())).not.toContain('/secret/path');
    expect(await s.call('POST', '/api/discovery/import', { key, confirm: true })).toEqual({ status: 200, json: { id: 'kubectl-readonly' } });
    expect(s.registry.list()).toHaveLength(1);
  });

  it('refuses to import a blocked production host', async () => {
    const s = setup();
    const key = ((await s.call('GET', '/api/discovery')).json as { servers: { name: string; key: string }[] }).servers.find((x) => x.name === 'bifrost')!.key;
    expect((await s.call('POST', '/api/discovery/import', { key, confirm: true })).status).toBe(409);
  });

  it('connectors list shows tools with their effective mode', async () => {
    const s = setup();
    await s.call('POST', '/api/connectors', { name: 'qmd', transport: 'stdio', command: 'qmd', args: ['mcp'], confirm: true });
    await s.call('PUT', '/api/tools/qmd__get_pods/mode', { mode: 'confirm' });
    const list = (await s.call('GET', '/api/connectors')).json as { tools: { qualified: string; mode: string; reason: string }[] }[];
    expect(list[0]!.tools[0]).toMatchObject({ qualified: 'qmd__get_pods', mode: 'confirm', reason: 'override' });
  });

  it('rejects a custom connector on a denied host and bad bodies', async () => {
    const s = setup();
    expect((await s.call('POST', '/api/connectors', { name: 'x', transport: 'http', url: 'https://a.prd.meesho.int/mcp', confirm: true })).status).toBe(409);
    expect((await s.call('POST', '/api/connectors', { name: 'x', transport: 'stdio', confirm: true })).status).toBe(400);
    expect((await s.call('PUT', '/api/tools/x__y/mode', { mode: 'yolo' })).status).toBe(400);
  });

  it('delete removes secrets and the server', async () => {
    const s = setup();
    await s.call('POST', '/api/connectors', { name: 'svc', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer abc' }, confirm: true });
    expect(await s.secrets.get(secretKey('svc', 'Authorization'))).toBe('Bearer abc');
    expect(await s.call('DELETE', '/api/connectors/svc')).toEqual({ status: 200, json: { ok: true } });
    expect(await s.secrets.get(secretKey('svc', 'Authorization'))).toBeUndefined();
    expect(s.registry.list()).toEqual([]);
  });

  it('test-tool runs the tool and audits it as confirmed', async () => {
    const s = setup();
    await s.call('POST', '/api/connectors', { name: 'qmd', transport: 'stdio', command: 'qmd', confirm: true });
    const r = await s.call('POST', '/api/tools/qmd__get_pods/test', { args: { ns: 'x' } });
    expect(r.json).toEqual({ ok: true, text: 'pods: a,b', ms: 3 });
    expect(s.audit.list()[0]).toMatchObject({ serverId: 'qmd', tool: 'get_pods', decision: 'confirmed' });
  });

  it('scan dirs must be existing absolute directories', async () => {
    const s = setup();
    expect((await s.call('POST', '/api/settings/scan-dirs', { dir: 'relative/path' })).status).toBe(400);
    const d = join(s.root, 'repos');
    mkdirSync(d);
    expect((await s.call('POST', '/api/settings/scan-dirs', { dir: d })).json).toEqual({ scanDirs: [d] });
  });

  it('404s unknown routes', async () => {
    expect((await setup().call('GET', '/api/nope')).status).toBe(404);
  });
});
