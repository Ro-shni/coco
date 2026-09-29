import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AuditLog } from '../../src/agent/audit.js';
import type { ConnectorManager } from '../../src/connectors/manager.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import { MemorySecretStore, secretKey } from '../../src/connectors/secrets.js';
import { handleApi, type ApiDeps } from '../../src/studio/api.js';

function setup(extraServers: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coco-api-'));
  const claudeJsonPath = join(root, 'claude.json');
  writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: {
    'kubectl-readonly': { type: 'stdio', command: '/usr/bin/python3', args: ['--read-only'], env: { KUBECONFIG: '/secret/path' } },
    bifrost: { type: 'http', url: 'http://ai-gateway.prd.meesho.int/mcp', headers: { Authorization: 'Bearer sk-SECRET' } },
    ...extraServers,
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

  it('rolls back stored secrets if upsert throws during import (I3)', async () => {
    const s = setup();
    const key = ((await s.call('GET', '/api/discovery')).json as { servers: { name: string; key: string }[] }).servers.find((x) => x.name === 'kubectl-readonly')!.key;
    vi.spyOn(s.registry, 'upsert').mockImplementation(() => { throw new Error('disk full'); });
    const res = await s.call('POST', '/api/discovery/import', { key, confirm: true });
    expect(res.status).toBe(500);
    expect(await s.secrets.get(secretKey('kubectl-readonly', 'KUBECONFIG'))).toBeUndefined();
  });

  it('rejects an import whose secret values contain control characters, before any write (N2)', async () => {
    const s = setup({ bad: { type: 'stdio', command: '/usr/bin/tool', args: [], env: { TOKEN: 'bad\nvalue' } } });
    const key = ((await s.call('GET', '/api/discovery')).json as { servers: { name: string; key: string }[] }).servers.find((x) => x.name === 'bad')!.key;
    const res = await s.call('POST', '/api/discovery/import', { key, confirm: true });
    expect(res.status).toBe(400);
    expect(s.registry.list()).toEqual([]);
    expect(await s.secrets.get(secretKey('bad', 'TOKEN'))).toBeUndefined();
  });

  it('rolls back already-stored secrets if a later secret write fails during import (N2)', async () => {
    const s = setup({ multi: { type: 'stdio', command: '/usr/bin/tool', args: [], env: { A: '1', B: '2' } } });
    const key = ((await s.call('GET', '/api/discovery')).json as { servers: { name: string; key: string }[] }).servers.find((x) => x.name === 'multi')!.key;
    let calls = 0;
    const realSet = s.secrets.set.bind(s.secrets);
    vi.spyOn(s.secrets, 'set').mockImplementation(async (k: string, v: string) => {
      calls += 1;
      if (calls === 2) throw new Error('keychain write failed (1)');
      return realSet(k, v);
    });
    const res = await s.call('POST', '/api/discovery/import', { key, confirm: true });
    expect(res.status).toBe(500);
    expect(s.registry.list()).toEqual([]);
    expect(await s.secrets.get(secretKey('multi', 'A'))).toBeUndefined();
  });

  it('connectors list shows tools with their effective mode', async () => {
    const s = setup();
    await s.call('POST', '/api/connectors', { name: 'qmd', transport: 'stdio', command: 'qmd', args: ['mcp'], confirm: true });
    await s.call('PUT', '/api/tools/qmd__get_pods/mode', { mode: 'confirm' });
    const list = (await s.call('GET', '/api/connectors')).json as { tools: { qualified: string; mode: string; reason: string }[] }[];
    expect(list[0]!.tools[0]).toMatchObject({ qualified: 'qmd__get_pods', mode: 'confirm', reason: 'override' });
  });

  it('connectors list defaults to a disconnected status when the manager reports none (M8)', async () => {
    const s = setup();
    await s.call('POST', '/api/connectors', { name: 'ghost', transport: 'stdio', command: 'ghost', confirm: true });
    (s.manager as unknown as { statuses: () => unknown[] }).statuses = () => [];
    const list = (await s.call('GET', '/api/connectors')).json as { config: { id: string }; status: { id: string; state: string; toolCount: number; since: number } }[];
    expect(list[0]!.status).toEqual({ id: 'ghost', state: 'disconnected', toolCount: 0, since: 0 });
  });

  it('rejects a custom connector on a denied host and bad bodies', async () => {
    const s = setup();
    expect((await s.call('POST', '/api/connectors', { name: 'x', transport: 'http', url: 'https://a.prd.meesho.int/mcp', confirm: true })).status).toBe(409);
    expect((await s.call('POST', '/api/connectors', { name: 'x', transport: 'stdio', confirm: true })).status).toBe(400);
    expect((await s.call('PUT', '/api/tools/x__y/mode', { mode: 'yolo' })).status).toBe(400);
  });

  it('rejects a custom connector added without confirm:true', async () => {
    const s = setup();
    expect((await s.call('POST', '/api/connectors', { name: 'y', transport: 'stdio', command: 'y' })).status).toBe(400);
    expect(s.registry.list()).toEqual([]);
  });

  it('rejects a custom URL containing userinfo (M7)', async () => {
    const s = setup();
    const res = await s.call('POST', '/api/connectors', { name: 'y', transport: 'http', url: 'https://user:pass@example.com/mcp', confirm: true });
    expect(res.status).toBe(400);
    expect(s.registry.list()).toEqual([]);
  });

  it('rejects secret values containing control characters, before any write (I3)', async () => {
    const s = setup();
    const res = await s.call('POST', '/api/connectors', { name: 'y', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'bad\nvalue' }, confirm: true });
    expect(res.status).toBe(400);
    expect(s.registry.list()).toEqual([]);
  });

  it('rolls back the registry entry and any already-stored secrets if a secret write fails (I3)', async () => {
    const s = setup();
    let calls = 0;
    const realSet = s.secrets.set.bind(s.secrets);
    vi.spyOn(s.secrets, 'set').mockImplementation(async (key: string, value: string) => {
      calls += 1;
      if (calls === 2) throw new Error('keychain write failed (1)');
      return realSet(key, value);
    });
    const res = await s.call('POST', '/api/connectors', { name: 'multi', transport: 'http', url: 'https://example.com/mcp', headers: { A: '1', B: '2' }, confirm: true });
    expect(res.status).toBe(500);
    expect(s.registry.list()).toEqual([]);
    expect(await s.secrets.get(secretKey('multi', 'A'))).toBeUndefined();
  });

  it('a malformed percent-escape in the path is a 400, not a crash (M1)', async () => {
    const s = setup();
    expect((await s.call('GET', '/api/connectors/%E4')).status).toBe(400);
  });

  it('delete removes secrets and the server', async () => {
    const s = setup();
    await s.call('POST', '/api/connectors', { name: 'svc', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer abc' }, confirm: true });
    expect(await s.secrets.get(secretKey('svc', 'Authorization'))).toBe('Bearer abc');
    expect(await s.call('DELETE', '/api/connectors/svc')).toEqual({ status: 200, json: { ok: true } });
    expect(await s.secrets.get(secretKey('svc', 'Authorization'))).toBeUndefined();
    expect(s.registry.list()).toEqual([]);
  });

  it('enabled toggles a connector and disconnects it when turned off', async () => {
    const s = setup();
    await s.call('POST', '/api/connectors', { name: 'qmd', transport: 'stdio', command: 'qmd', confirm: true });
    const res = await s.call('POST', '/api/connectors/qmd/enabled', { enabled: false });
    expect(res).toEqual({ status: 200, json: { ok: true } });
    expect(s.manager.disconnect).toHaveBeenCalledWith('qmd');
    expect(s.registry.get('qmd')!.enabled).toBe(false);
  });

  it('enabled requires a boolean', async () => {
    const s = setup();
    await s.call('POST', '/api/connectors', { name: 'qmd', transport: 'stdio', command: 'qmd', confirm: true });
    expect((await s.call('POST', '/api/connectors/qmd/enabled', { enabled: 'nope' })).status).toBe(400);
  });

  it('reconnect disconnects then reconnects a connector', async () => {
    const s = setup();
    await s.call('POST', '/api/connectors', { name: 'qmd', transport: 'stdio', command: 'qmd', confirm: true });
    const res = await s.call('POST', '/api/connectors/qmd/reconnect');
    expect(s.manager.disconnect).toHaveBeenCalledWith('qmd');
    expect(s.manager.ensureConnected).toHaveBeenCalledWith('qmd');
    expect(res.json).toMatchObject({ id: 'qmd', state: 'connected' });
  });

  it('operating on an unknown connector is 404', async () => {
    const s = setup();
    expect((await s.call('POST', '/api/connectors/nope/enabled', { enabled: true })).status).toBe(404);
    expect((await s.call('POST', '/api/connectors/nope/reconnect')).status).toBe(404);
    expect((await s.call('DELETE', '/api/connectors/nope')).status).toBe(404);
  });

  it('test-tool runs the tool and audits it as confirmed', async () => {
    const s = setup();
    await s.call('POST', '/api/connectors', { name: 'qmd', transport: 'stdio', command: 'qmd', confirm: true });
    const r = await s.call('POST', '/api/tools/qmd__get_pods/test', { args: { ns: 'x' } });
    expect(r.json).toEqual({ ok: true, text: 'pods: a,b', ms: 3 });
    expect(s.audit.list()[0]).toMatchObject({ serverId: 'qmd', tool: 'get_pods', decision: 'confirmed' });
  });

  it('audit lists recorded runs and can be filtered by decision', async () => {
    const s = setup();
    await s.call('POST', '/api/connectors', { name: 'qmd', transport: 'stdio', command: 'qmd', confirm: true });
    await s.call('POST', '/api/tools/qmd__get_pods/test', { args: {} });
    const all = (await s.call('GET', '/api/audit')).json as { decision: string }[];
    expect(all).toHaveLength(1);
    expect(all[0]!.decision).toBe('confirmed');
    const filtered = (await s.call('GET', '/api/audit', undefined, 'decision=denied')).json as unknown[];
    expect(filtered).toHaveLength(0);
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

describe('catalog routes', () => {
  it('lists catalog entries with added flags and adds one with confirm', async () => {
    const s = setup();
    const before = (await s.call('GET', '/api/catalog')).json as { id: string; added: boolean }[];
    expect(before.find((e) => e.id === 'atlassian')!.added).toBe(false);
    expect((await s.call('POST', '/api/catalog/atlassian/add', {})).status).toBe(400);
    expect((await s.call('POST', '/api/catalog/atlassian/add', { confirm: true })).json).toEqual({ id: 'atlassian' });
    const after = (await s.call('GET', '/api/catalog')).json as { id: string; added: boolean }[];
    expect(after.find((e) => e.id === 'atlassian')!.added).toBe(true);
  });

  it('refuses Slack without a Client ID', async () => {
    const s = setup();
    expect((await s.call('POST', '/api/catalog/slack/add', { confirm: true })).status).toBe(400);
  });
});

describe('connector auth route', () => {
  it('ensures the connection and omits authorizationUrl when there is no pending sign-in', async () => {
    const s = setup();
    await s.call('POST', '/api/catalog/atlassian/add', { confirm: true });
    const res = await s.call('POST', '/api/connectors/atlassian/auth');
    expect(s.manager.ensureConnected).toHaveBeenCalledWith('atlassian');
    expect(res.json).toEqual({ state: 'connected' });
  });

  it('surfaces the pending authorization URL when oauth reports one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coco-api-auth-'));
    const claudeJsonPath = join(root, 'claude.json');
    writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: {} }));
    const registry = new ConnectorRegistry(root);
    const secrets = new MemorySecretStore();
    const audit = new AuditLog(join(root, 'coco.db'));
    const manager = {
      statuses: () => [],
      tools: () => [],
      ensureConnected: vi.fn(async (id: string) => ({ id, state: 'needs_auth', toolCount: 0, since: 0 })),
    } as unknown as ConnectorManager;
    const deps: ApiDeps = {
      registry, manager, secrets, audit, health: async () => true, models: { main: 'm', vision: 'v' },
      claudeJsonPath, scanDirs: () => [], addScanDir: () => undefined, clock: () => 42,
      oauth: { pendingUrl: (id) => (id === 'atlassian' ? 'https://auth.atlassian.com/authorize?state=1' : undefined) },
    };
    await handleApi({ method: 'POST', path: '/api/catalog/atlassian/add', query: new URLSearchParams(), body: { confirm: true } }, deps);
    const res = await handleApi({ method: 'POST', path: '/api/connectors/atlassian/auth', query: new URLSearchParams(), body: undefined }, deps);
    expect(res.json).toEqual({ state: 'needs_auth', authorizationUrl: 'https://auth.atlassian.com/authorize?state=1' });
  });
});

describe('final security fixes', () => {
  it('deleting a connector also forgets its OAuth tokens and client', async () => {
    const s = setup();
    await s.call('POST', '/api/catalog/atlassian/add', { confirm: true });
    await s.secrets.set(secretKey('atlassian', 'oauth_tokens'), '{"access_token":"at"}');
    await s.secrets.set(secretKey('atlassian', 'oauth_client'), '{"client_id":"c"}');
    expect((await s.call('DELETE', '/api/connectors/atlassian')).status).toBe(200);
    expect(await s.secrets.get(secretKey('atlassian', 'oauth_tokens'))).toBeUndefined();
    expect(await s.secrets.get(secretKey('atlassian', 'oauth_client'))).toBeUndefined();
  });

  it('catalog add rejects credential names the entry does not declare', async () => {
    const s = setup();
    const r = await s.call('POST', '/api/catalog/github/add', { confirm: true, headers: { Authorization: 'Bearer x', oauth_tokens: '{"access_token":"evil"}' } });
    expect(r.status).toBe(400);
    expect(await s.secrets.get(secretKey('github', 'oauth_tokens'))).toBeUndefined();
  });
});
