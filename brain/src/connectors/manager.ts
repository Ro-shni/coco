import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../logger.js';
import { safeFetch } from './safeFetch.js';
import type { ConnectorRegistry } from './registry.js';
import { secretKey, type SecretStore } from './secrets.js';
import { qualify, type ServerConfig, type ServerState, type ServerStatus, type ToolInfo } from './types.js';

export interface ToolResult { ok: boolean; text: string; ms: number }
export type TransportFactory = (cfg: ServerConfig, secrets: { env: Record<string, string>; headers: Record<string, string> }) => Promise<Transport>;

const MAX_RESULT_CHARS = 4000;
const TRUNC = '…[truncated]';
/** I3: a name outside this shape (e.g. containing `"`, `<`, `>`, newlines) could break out of the
 * `<untrusted source="mcp:<server>/<tool>">` wrapper the tool loop puts results in. Never list, offer, or run it.
 * R1-M3: 128 chars, matching MCP's own tool-name length guidance, rather than an arbitrary stricter 64. */
const VALID_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const BACKOFF_MIN_MS = 30_000;
const BACKOFF_MAX_MS = 600_000;
/** M-1: only reset the back-off multiplier once a connection has stayed up at least this long. */
const STABLE_CONNECTION_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 20_000;

interface Live {
  state: ServerState;
  since: number;
  error?: string;
  client?: Client;
  tools: ToolInfo[];
  retryAt: number;
  backoffMs: number;
  connecting?: Promise<void>;
  /** I-2: bumped on every explicit disconnect so a connect attempt in flight at the time can tell it has been superseded. */
  epoch: number;
  /** I-2/I-4: aborts the in-flight connect's SDK requests so `disconnect` does not have to wait out the connect budget. */
  abort?: AbortController;
  /** M-1: set when a connect succeeds; cleared on any failure. Used to decide whether the back-off resets. */
  connectedAt?: number;
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

/** M-6: status error text reaches Studio's status API, so strip anything that looks like a URL (query strings, endpoints). */
const stripUrls = (s: string): string => s.replace(/https?:\/\/\S+/gi, '<url>');

const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE']);
const CONNECTION_ERROR_TEXT = /fetch failed|connection closed/i;

/**
 * N-1: a callTool (or listTools) request can fail because the underlying connection actually died — as opposed to
 * a protocol-level hiccup (bad framing, a late/duplicate response, an unmatched progress token) that `onerror`
 * also reports but that leaves a perfectly usable connection behind. Walks the `.cause` chain because Node's
 * `fetch()` wraps a refused/reset socket in a top-level `TypeError: fetch failed`.
 *
 * N-4/N-7: an `McpError` is never a connection error. It is either the SDK's wrapper for a server-sent JSON-RPC
 * error response (a healthy server can reply with text like "fetch failed", or with the generic code -32000,
 * which equals the SDK's `ErrorCode.ConnectionClosed`), or the SDK's own `ConnectionClosed`, which it raises only
 * from `_onclose` after our `onclose` has already recorded the failure. The errno/text checks below apply only to
 * errors the transport or `fetch()` itself throws.
 */
function isConnectionError(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur instanceof Error; i++) {
    if (cur instanceof McpError) return false;
    const code = (cur as NodeJS.ErrnoException).code;
    if (code && CONNECTION_ERROR_CODES.has(code)) return true;
    if (CONNECTION_ERROR_TEXT.test(cur.message)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

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
      e = { state: 'disconnected', since: this.deps.clock(), tools: [], retryAt: 0, backoffMs: BACKOFF_MIN_MS, epoch: 0 };
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
    // I-3: needs_auth backs off exactly like error, so it does not reconnect (and potentially re-prompt) on every call.
    if ((e.state === 'error' || e.state === 'needs_auth') && this.deps.clock() < e.retryAt) return this.status(id);
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
      fetch: safeFetch(),
      ...(cfg.auth === 'oauth' && this.oauthProviderFor ? { authProvider: this.oauthProviderFor(cfg) } : {}),
    });
  };

  private async connect(cfg: ServerConfig, e: Live): Promise<void> {
    const epoch = e.epoch;
    const controller = new AbortController();
    e.abort = controller;
    this.setState(e, 'connecting');
    let client: Client | undefined;
    try {
      const transport = await (this.deps.transportFactory ?? this.defaultTransport)(cfg, await this.resolveSecrets(cfg));
      // I-2: a disconnect() that landed while we were still resolving secrets/building the transport wins.
      if (e.epoch !== epoch) {
        await transport.close().catch(() => undefined);
        return;
      }
      client = new Client({ name: 'coco', version: '0.1.0' });
      client.onclose = () => {
        if (e.client === client) {
          e.client = undefined;
          this.fail(cfg.id, e, 'server closed the connection');
        }
      };
      // N-1: the SDK also reports non-fatal protocol conditions through onerror — e.g. a late response arriving
      // for a call we already cancelled/timed out ("Received a response for an unknown message ID"). Treating
      // every onerror as fatal marked a healthy server `error` and orphaned its still-live client/child (the old
      // M-7 fix). Just log it; a genuine connection failure is instead detected in callTool via isConnectionError()
      // and reacted to there by closing the client, whose `onclose` (above) is the one source of truth for a crash.
      client.onerror = () => {
        this.deps.log.warn('connector_transport_error', { id: cfg.id });
      };

      // I-1/C-1: connect + listTools share ONE connect budget; each request also carries the SDK's own {timeout, signal}
      // so the SDK itself gives up (and, for callTool's counterpart, cancels) rather than relying solely on our wrapper.
      const budgetMs = this.deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      const connectStarted = Date.now();
      await withTimeout(client.connect(transport, { timeout: budgetMs, signal: controller.signal }), budgetMs, 'connect');
      if (e.epoch !== epoch) {
        await client.close().catch(() => undefined);
        return;
      }
      const listBudgetMs = Math.max(1, budgetMs - (Date.now() - connectStarted));
      const listed = await withTimeout(
        client.listTools(undefined, { timeout: listBudgetMs, signal: controller.signal }),
        listBudgetMs,
        'listTools',
      );
      if (e.epoch !== epoch) {
        await client.close().catch(() => undefined);
        return;
      }
      e.client = client;
      this.setState(e, 'connected');
      e.connectedAt = this.deps.clock();
      const validTools = listed.tools.filter((t) => VALID_TOOL_NAME.test(t.name));
      const droppedInvalidNames = listed.tools.length - validTools.length;
      e.tools = validTools.map((t) => ({
        serverId: cfg.id,
        name: t.name,
        qualified: qualify(cfg.id, t.name),
        description: (t.description ?? '').slice(0, 500),
        inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
      }));
      this.deps.log.info('connector_connected', {
        id: cfg.id,
        tools: e.tools.length,
        ...(droppedInvalidNames > 0 ? { droppedInvalidNames } : {}),
      });
    } catch (err) {
      // C-1: close the client (which closes its transport, killing a stdio child) on every failure path.
      await client?.close().catch(() => undefined);
      if (e.epoch !== epoch) return; // superseded by a disconnect(); it already recorded the state we want.
      // The SDK's UnauthorizedError keeps the default name "Error", so match the class (the name check stays for
      // errors re-thrown across module copies).
      if (err instanceof UnauthorizedError || (err as Error).name === 'UnauthorizedError') {
        this.fail(cfg.id, e, 'sign-in required', 'needs_auth');
      } else {
        this.fail(cfg.id, e, (err as Error).message.slice(0, 200));
      }
    } finally {
      if (e.abort === controller) e.abort = undefined;
    }
  }

  private fail(id: string, e: Live, message: string, state: ServerState = 'error'): void {
    // M-1: only forgive past back-off once the connection actually stayed up for a while; a flapping server keeps backing off.
    if (e.connectedAt !== undefined && this.deps.clock() - e.connectedAt >= STABLE_CONNECTION_MS) {
      e.backoffMs = BACKOFF_MIN_MS;
    }
    e.connectedAt = undefined;
    this.setState(e, state, stripUrls(message));
    e.retryAt = this.deps.clock() + e.backoffMs;
    e.backoffMs = Math.min(e.backoffMs * 2, BACKOFF_MAX_MS);
    // M-3: include the id so the log line is actionable; needs_auth gets its own event (it was not logged at all before).
    if (state === 'needs_auth') {
      this.deps.log.warn('connector_needs_auth', { id });
    } else {
      this.deps.log.warn('connector_error', { id, state: 'error' });
    }
  }

  async callTool(qualified: string, args: Record<string, unknown>): Promise<ToolResult> {
    const started = this.deps.clock();
    const sep = qualified.indexOf('__');
    const serverId = sep === -1 ? '' : qualified.slice(0, sep);
    const cfg = serverId ? this.deps.registry.get(serverId) : undefined;
    if (cfg) await this.ensureConnected(serverId);
    const tool = this.tools().find((t) => t.qualified === qualified);
    const live = tool ? this.live.get(tool.serverId) : undefined;
    if (!tool || !live?.client) {
      // M-2: a tool the caller knows about, on a server that just isn't up right now, is a different failure than a typo.
      if (cfg) {
        const state = this.status(serverId).state;
        if (state !== 'connected') return { ok: false, text: `server ${serverId} is unavailable (${state})`, ms: this.deps.clock() - started };
      }
      return { ok: false, text: `unknown tool ${qualified}`, ms: this.deps.clock() - started };
    }
    // N-5: capture the client that is actually making this call. `live.client` can change out from under us while
    // we `await` (a disconnect + fresh reconnect can both complete before a stale call rejects) — closing whatever
    // `live.client` happens to be *then* could close a brand-new, healthy client instead of the one that failed.
    const client = live.client;
    const callTimeoutMs = this.deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    // I-4: an AbortController tied to the call timeout, on top of the SDK's own {timeout}, so a timed-out call is actually
    // cancelled (the SDK sends notifications/cancelled) instead of just being ignored by us while it keeps running server-side.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(new Error(`tool call timed out after ${callTimeoutMs} ms`)), callTimeoutMs);
    try {
      const result = await withTimeout(
        client.callTool({ name: tool.name, arguments: args }, undefined, { timeout: callTimeoutMs, signal: controller.signal }),
        callTimeoutMs,
        'tool call',
      );
      const isError = (result as { isError?: boolean }).isError === true;
      return { ok: !isError, text: truncate(flattenContent(result)), ms: this.deps.clock() - started };
    } catch (err) {
      // M-7 (re-met per N-1's ruling): a genuine connection error — as opposed to a protocol-level onerror — closes
      // the client that made *this* call (N-5), not whatever `live.client` happens to be by now. Its `onclose` then
      // records the failure and applies back-off; we don't set state here directly.
      if (isConnectionError(err)) {
        await client.close().catch(() => undefined);
      }
      return { ok: false, text: truncate(`error: ${(err as Error).message}`), ms: this.deps.clock() - started };
    } finally {
      clearTimeout(abortTimer);
    }
  }

  async disconnect(id: string): Promise<void> {
    const e = this.live.get(id);
    if (!e) return;
    e.epoch++; // I-2: any connect in flight now knows it has been superseded.
    e.abort?.abort(new Error('disconnected')); // I-2/I-4: don't make the caller wait out the connect budget for a discarded connect.
    const pending = e.connecting;
    const client = e.client;
    e.client = undefined;
    this.setState(e, 'disconnected');
    await client?.close().catch(() => undefined);
    if (pending) await pending.catch(() => undefined); // wait for the in-flight connect to finish closing its own client.
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.disconnect(id)));
  }
}
