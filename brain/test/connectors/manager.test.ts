import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorManager, type TransportFactory } from '../../src/connectors/manager.js';
import { ConnectorRegistry } from '../../src/connectors/registry.js';
import { MemorySecretStore, secretKey } from '../../src/connectors/secrets.js';
import type { ServerConfig } from '../../src/connectors/types.js';
import type { Logger } from '../../src/logger.js';
import { silentLogger } from '../../src/logger.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'mcp-server.mjs');
const fixtureCfg = (over: Partial<ServerConfig> = {}): ServerConfig => ({
  id: 'fx', name: 'fixture', transport: 'stdio', command: process.execPath, args: [FIXTURE],
  envSecrets: ['FIXTURE_SECRET'], headerSecrets: [], auth: 'none', enabled: true, source: 'custom', readOnly: false, ...over,
});

/**
 * A minimal, fully in-memory MCP transport for tests that need deterministic control over the handshake
 * (never respond to initialize / never respond to tools/list) without spawning a real process. Responds
 * to `initialize` and `tools/list` like a real server unless told to hang on one of them.
 */
class ScriptedTransport implements Transport {
  closed = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: { jsonrpc: '2.0'; id?: number; method?: string; result?: unknown }) => void;

  constructor(private readonly opts: { hangInit?: boolean; hangListTools?: boolean } = {}) {}

  async start(): Promise<void> {}

  async send(message: { jsonrpc: '2.0'; id?: number; method?: string }): Promise<void> {
    if (message.method === 'initialize' && !this.opts.hangInit) {
      queueMicrotask(() =>
        this.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'scripted', version: '1.0.0' } },
        }),
      );
    } else if (message.method === 'tools/list' && !this.opts.hangListTools) {
      queueMicrotask(() => this.onmessage?.({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }));
    }
    // Everything else (notifications, or a method we're told to hang on): no response.
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

let managers: ConnectorManager[] = [];
afterEach(async () => {
  await Promise.all(managers.map((m) => m.closeAll()));
  managers = [];
});

async function setup(
  cfg = fixtureCfg(),
  opts: { callTimeoutMs?: number; connectTimeoutMs?: number; transportFactory?: TransportFactory; log?: Logger } = {},
) {
  const registry = new ConnectorRegistry(mkdtempSync(join(tmpdir(), 'coco-mgr-')));
  registry.upsert(cfg);
  const secrets = new MemorySecretStore();
  await secrets.set(secretKey(cfg.id, 'FIXTURE_SECRET'), 's3cr3t');
  let now = 1_000_000;
  const m = new ConnectorManager({
    registry,
    secrets,
    clock: () => now,
    log: opts.log ?? silentLogger,
    callTimeoutMs: opts.callTimeoutMs ?? 20_000,
    connectTimeoutMs: opts.connectTimeoutMs,
    transportFactory: opts.transportFactory,
  });
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

  it('backs off after a failed connect and retries after 30 s (counting actual connect attempts)', async () => {
    const events: { event: string; data?: Record<string, unknown> }[] = [];
    const log: Logger = { info: () => undefined, warn: (event, data) => events.push({ event, data }), error: () => undefined };
    let calls = 0;
    const factory: TransportFactory = async () => {
      calls++;
      throw new Error('boom');
    };
    const { m, advance } = await setup(fixtureCfg(), { transportFactory: factory, log });

    expect((await m.ensureConnected('fx')).state).toBe('error');
    expect(calls).toBe(1);

    const again = await m.ensureConnected('fx'); // within back-off: no new attempt
    expect(again.state).toBe('error');
    expect(calls).toBe(1);

    advance(29_999);
    expect((await m.ensureConnected('fx')).state).toBe('error');
    expect(calls).toBe(1); // still blocked, 1 ms short of the 30 s gate

    advance(1);
    expect((await m.ensureConnected('fx')).state).toBe('error'); // retried (still failing), no throw
    expect(calls).toBe(2);

    // M-3: the error log carries the server id.
    expect(events).toContainEqual({ event: 'connector_error', data: { id: 'fx', state: 'error' } });
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

  it('M-2: a known tool on a server that is not connected reports the server as unavailable', async () => {
    const { m } = await setup(fixtureCfg({ command: '/nonexistent/binary' }));
    const r = await m.callTool('fx__echo', {});
    expect(r).toMatchObject({ ok: false, text: 'server fx is unavailable (error)' });
  });

  it('M-6: strips URLs out of the status error text', async () => {
    const factory: TransportFactory = async () => {
      throw new Error('fetch failed: https://ai-gateway.prd.meesho.int/mcp?token=s3cr3t');
    };
    const { m } = await setup(fixtureCfg(), { transportFactory: factory });
    const st = await m.ensureConnected('fx');
    expect(st.state).toBe('error');
    expect(st.error).toBeDefined();
    expect(st.error).not.toMatch(/https?:\/\//i);
  });
});

describe('ConnectorManager (scripted / fake transport)', () => {
  it('I-5: dedups concurrent ensureConnected calls to a single connect attempt', async () => {
    let calls = 0;
    const factory: TransportFactory = async () => {
      calls++;
      return new ScriptedTransport();
    };
    const { m } = await setup(fixtureCfg(), { transportFactory: factory });
    const [a, b] = await Promise.all([m.ensureConnected('fx'), m.ensureConnected('fx')]);
    expect(a.state).toBe('connected');
    expect(b.state).toBe('connected');
    expect(calls).toBe(1);
  });

  it('C-1: a connect that never gets an initialize response times out, closes the transport, and errors', async () => {
    let transport: ScriptedTransport | undefined;
    const factory: TransportFactory = async () => {
      transport = new ScriptedTransport({ hangInit: true });
      return transport;
    };
    const { m } = await setup(fixtureCfg(), { transportFactory: factory, connectTimeoutMs: 150 });
    const st = await m.ensureConnected('fx');
    expect(st.state).toBe('error');
    expect(transport?.closed).toBe(true);
  });

  it('C-1: a listTools call that never responds times out, closes the transport, and errors', async () => {
    let transport: ScriptedTransport | undefined;
    const factory: TransportFactory = async () => {
      transport = new ScriptedTransport({ hangListTools: true });
      return transport;
    };
    const { m } = await setup(fixtureCfg(), { transportFactory: factory, connectTimeoutMs: 150 });
    const st = await m.ensureConnected('fx');
    expect(st.state).toBe('error');
    expect(transport?.closed).toBe(true);
  });

  it('I-2: disconnect racing a still-connecting server leaves it disconnected and closes the transport', async () => {
    let transport: ScriptedTransport | undefined;
    const factory: TransportFactory = async () => {
      transport = new ScriptedTransport({ hangInit: true }); // never resolves on its own; only disconnect() ends it
      return transport;
    };
    const { m } = await setup(fixtureCfg(), { transportFactory: factory });
    const connecting = m.ensureConnected('fx');
    await new Promise((r) => setTimeout(r, 20)); // let connect() reach the pending initialize request
    await m.disconnect('fx');
    const status = await connecting;
    expect(status.state).toBe('disconnected');
    expect(transport?.closed).toBe(true);
  });

  it('I-3: needs_auth backs off like error and is logged (M-3)', async () => {
    const events: { event: string; data?: Record<string, unknown> }[] = [];
    const log: Logger = { info: () => undefined, warn: (event, data) => events.push({ event, data }), error: () => undefined };
    let calls = 0;
    const factory: TransportFactory = async () => {
      calls++;
      throw Object.assign(new Error('sign-in required'), { name: 'UnauthorizedError' });
    };
    const { m, advance } = await setup(fixtureCfg(), { transportFactory: factory, log });

    expect((await m.ensureConnected('fx')).state).toBe('needs_auth');
    expect(calls).toBe(1);

    const again = await m.ensureConnected('fx'); // within back-off: must not reconnect (and re-prompt) on every call
    expect(again.state).toBe('needs_auth');
    expect(calls).toBe(1);

    advance(31_000);
    expect((await m.ensureConnected('fx')).state).toBe('needs_auth');
    expect(calls).toBe(2); // retried after the back-off window

    expect(events).toContainEqual({ event: 'connector_needs_auth', data: { id: 'fx' } });
  });

  it('M-7: a transport-level error (no close) is treated as a failure with back-off', async () => {
    let transport: ScriptedTransport | undefined;
    const factory: TransportFactory = async () => {
      transport = new ScriptedTransport();
      return transport;
    };
    const { m, advance } = await setup(fixtureCfg(), { transportFactory: factory });
    expect((await m.ensureConnected('fx')).state).toBe('connected');

    transport?.onerror?.(new Error('stream broke'));
    await new Promise((r) => setTimeout(r, 20));
    expect(m.statuses()[0]!.state).toBe('error');

    // and it backs off exactly like any other failure — an immediate retry is blocked
    const again = await m.ensureConnected('fx');
    expect(again.state).toBe('error');
    advance(30_000);
    expect((await m.ensureConnected('fx')).state).toBe('connected'); // reconnect succeeds (ScriptedTransport is fresh each time)
  });

  it('I-5/M-1: back-off doubles up to a 10 min cap, then resets after a stable (>=60s) connection', async () => {
    let calls = 0;
    let mode: 'fail' | 'succeed' = 'fail';
    let transport: ScriptedTransport | undefined;
    const factory: TransportFactory = async () => {
      calls++;
      if (mode === 'fail') throw new Error('boom');
      transport = new ScriptedTransport();
      return transport;
    };
    const { m, advance } = await setup(fixtureCfg(), { transportFactory: factory });

    expect((await m.ensureConnected('fx')).state).toBe('error');
    expect(calls).toBe(1);

    let gap = 30_000;
    let expectedCalls = 1;
    for (let i = 0; i < 6; i++) {
      advance(gap - 1);
      expect((await m.ensureConnected('fx')).state).toBe('error');
      expect(calls).toBe(expectedCalls); // still blocked, one ms short of the gate

      advance(1);
      expect((await m.ensureConnected('fx')).state).toBe('error'); // retried
      expectedCalls++;
      expect(calls).toBe(expectedCalls);

      gap = Math.min(gap * 2, 600_000);
    }
    // By now the gap has been capped at 600_000 for at least the last iteration — prove it stays capped, not growing.
    expect(gap).toBe(600_000);

    // Let the next retry succeed, and stay "up" for exactly the stability window.
    mode = 'succeed';
    advance(gap - 1);
    expect((await m.ensureConnected('fx')).state).toBe('error'); // still blocked
    advance(1);
    const connected = await m.ensureConnected('fx');
    expect(connected.state).toBe('connected');
    expectedCalls++;
    expect(calls).toBe(expectedCalls);

    advance(60_000); // stayed connected for >= the 60s stability window
    transport?.onclose?.(); // simulate the server going away
    await new Promise((r) => setTimeout(r, 20));
    expect(m.statuses()[0]!.state).toBe('error');

    // Reset proof: a retry now happens at the reset 30s gap, not at the pre-reset 600s cap.
    advance(29_999);
    expect((await m.ensureConnected('fx')).state).toBe('error');
    expect(calls).toBe(expectedCalls); // still blocked

    advance(1);
    await m.ensureConnected('fx');
    expect(calls).toBe(expectedCalls + 1); // retried at the 30s mark: proves the back-off was reset, not still capped
  });
});
