import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Logger } from '../logger.js';
import type { ConnectorRegistry } from './registry.js';
import { secretKey, type SecretStore } from './secrets.js';
import { qualify, type ServerConfig, type ServerState, type ServerStatus, type ToolInfo } from './types.js';

export interface ToolResult { ok: boolean; text: string; ms: number }
export type TransportFactory = (cfg: ServerConfig, secrets: { env: Record<string, string>; headers: Record<string, string> }) => Promise<Transport>;

const MAX_RESULT_CHARS = 4000;
const TRUNC = '…[truncated]';
const BACKOFF_MIN_MS = 30_000;
const BACKOFF_MAX_MS = 600_000;

interface Live {
  state: ServerState;
  since: number;
  error?: string;
  client?: Client;
  tools: ToolInfo[];
  retryAt: number;
  backoffMs: number;
  connecting?: Promise<void>;
}

export function flattenContent(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return JSON.stringify(result ?? null);
  return content
    .map((c: { type?: string; text?: string; resource?: { text?: string; uri?: string } }) =>
      c.type === 'text' ? (c.text ?? '') : c.type === 'resource' ? (c.resource?.text ?? c.resource?.uri ?? '') : `[${c.type ?? 'item'}]`,
    )
    .join('\n');
}

const truncate = (s: string): string => (s.length <= MAX_RESULT_CHARS ? s : s.slice(0, MAX_RESULT_CHARS - TRUNC.length) + TRUNC);

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export class ConnectorManager {
  onAuthRequired?: (id: string, authorizationUrl: URL) => void;
  /** Set by Task 10: returns the OAuth provider for an http server with auth === 'oauth'. */
  oauthProviderFor?: (cfg: ServerConfig) => OAuthClientProvider;
  private readonly live = new Map<string, Live>();

  constructor(
    private readonly deps: {
      registry: ConnectorRegistry;
      secrets: SecretStore;
      clock: () => number;
      log: Logger;
      transportFactory?: TransportFactory;
      callTimeoutMs?: number;
      connectTimeoutMs?: number;
    },
  ) {}

  private entry(id: string): Live {
    let e = this.live.get(id);
    if (!e) {
      e = { state: 'disconnected', since: this.deps.clock(), tools: [], retryAt: 0, backoffMs: BACKOFF_MIN_MS };
      this.live.set(id, e);
    }
    return e;
  }

  private setState(e: Live, state: ServerState, error?: string): void {
    e.state = state;
    e.since = this.deps.clock();
    e.error = error;
    if (state !== 'connected') e.tools = [];
  }

  statuses(): ServerStatus[] {
    return this.deps.registry.list().map((cfg) => {
      const e = this.entry(cfg.id);
      const state: ServerState = cfg.enabled ? e.state : 'disabled';
      return { id: cfg.id, state, ...(e.error ? { error: e.error } : {}), toolCount: e.tools.length, since: e.since };
    });
  }

  tools(): ToolInfo[] {
    return this.deps.registry.list().flatMap((cfg) => {
      const e = this.live.get(cfg.id);
      return cfg.enabled && e?.state === 'connected' ? e.tools : [];
    });
  }

  private status(id: string): ServerStatus {
    return this.statuses().find((s) => s.id === id) ?? { id, state: 'error', error: 'unknown server', toolCount: 0, since: this.deps.clock() };
  }

  async ensureConnected(id: string): Promise<ServerStatus> {
    const cfg = this.deps.registry.get(id);
    if (!cfg) return this.status(id);
    if (!cfg.enabled) return this.status(id);
    const e = this.entry(id);
    if (e.state === 'connected') return this.status(id);
    if (e.state === 'error' && this.deps.clock() < e.retryAt) return this.status(id);
    e.connecting ??= this.connect(cfg, e).finally(() => (e.connecting = undefined));
    await e.connecting;
    return this.status(id);
  }

  async connectAll(): Promise<void> {
    await Promise.all(this.deps.registry.list().filter((c) => c.enabled).map((c) => this.ensureConnected(c.id)));
  }

  private async resolveSecrets(cfg: ServerConfig) {
    const env: Record<string, string> = {};
    for (const name of cfg.envSecrets) {
      const v = await this.deps.secrets.get(secretKey(cfg.id, name));
      if (v !== undefined) env[name] = v;
    }
    const headers: Record<string, string> = {};
    for (const name of cfg.headerSecrets) {
      const v = await this.deps.secrets.get(secretKey(cfg.id, name));
      if (v !== undefined) headers[name] = v;
    }
    return { env, headers };
  }

  private defaultTransport: TransportFactory = async (cfg, secrets) => {
    if (cfg.transport === 'stdio') {
      return new StdioClientTransport({
        command: cfg.command!,
        args: cfg.args,
        env: { ...getDefaultEnvironment(), ...secrets.env },
        ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
        stderr: 'ignore',
      });
    }
    return new StreamableHTTPClientTransport(new URL(cfg.url!), {
      requestInit: { headers: secrets.headers },
      ...(cfg.auth === 'oauth' && this.oauthProviderFor ? { authProvider: this.oauthProviderFor(cfg) } : {}),
    });
  };

  private async connect(cfg: ServerConfig, e: Live): Promise<void> {
    this.setState(e, 'connecting');
    try {
      const transport = await (this.deps.transportFactory ?? this.defaultTransport)(cfg, await this.resolveSecrets(cfg));
      const client = new Client({ name: 'coco', version: '0.1.0' });
      client.onclose = () => {
        if (e.client === client) {
          e.client = undefined;
          this.fail(e, 'server closed the connection');
        }
      };
      await withTimeout(client.connect(transport), this.deps.connectTimeoutMs ?? 15_000, 'connect');
      const listed = await withTimeout(client.listTools(), this.deps.connectTimeoutMs ?? 15_000, 'listTools');
      e.client = client;
      this.setState(e, 'connected');
      e.backoffMs = BACKOFF_MIN_MS;
      e.tools = listed.tools.map((t) => ({
        serverId: cfg.id,
        name: t.name,
        qualified: qualify(cfg.id, t.name),
        description: (t.description ?? '').slice(0, 500),
        inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      }));
      this.deps.log.info('connector_connected', { id: cfg.id, tools: e.tools.length });
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'UnauthorizedError') {
        this.setState(e, 'needs_auth', 'sign-in required');
      } else {
        this.fail(e, (err as Error).message.slice(0, 200));
      }
    }
  }

  private fail(e: Live, message: string): void {
    this.setState(e, 'error', message);
    e.retryAt = this.deps.clock() + e.backoffMs;
    e.backoffMs = Math.min(e.backoffMs * 2, BACKOFF_MAX_MS);
    this.deps.log.warn('connector_error', { state: 'error' });
  }

  async callTool(qualified: string, args: Record<string, unknown>): Promise<ToolResult> {
    const started = this.deps.clock();
    const sep = qualified.indexOf('__');
    const serverId = sep === -1 ? '' : qualified.slice(0, sep);
    if (serverId) await this.ensureConnected(serverId);
    const tool = this.tools().find((t) => t.qualified === qualified);
    const e = tool ? this.live.get(tool.serverId) : undefined;
    if (!tool || !e?.client) return { ok: false, text: `unknown tool ${qualified}`, ms: 0 };
    try {
      const result = await withTimeout(e.client.callTool({ name: tool.name, arguments: args }), this.deps.callTimeoutMs ?? 20_000, 'tool call');
      const isError = (result as { isError?: boolean }).isError === true;
      return { ok: !isError, text: truncate(flattenContent(result)), ms: this.deps.clock() - started };
    } catch (err) {
      return { ok: false, text: truncate(`error: ${(err as Error).message}`), ms: this.deps.clock() - started };
    }
  }

  async disconnect(id: string): Promise<void> {
    const e = this.live.get(id);
    const client = e?.client;
    if (e) {
      e.client = undefined;
      this.setState(e, 'disconnected');
    }
    await client?.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.disconnect(id)));
  }
}
