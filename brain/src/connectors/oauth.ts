import { randomBytes } from 'node:crypto';
import { auth as sdkAuth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Logger } from '../logger.js';
import { assertSafeAuthUrl, safeFetch } from './safeFetch.js';
import { secretKey, type SecretStore } from './secrets.js';
import type { ServerConfig } from './types.js';

const TTL_MS = 10 * 60_000;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const PAGE_CSS = ':root{color-scheme:light dark;--bg:#fbf1e4;--card:#fffdf8;--fg:#2b1f38;--muted:#6f5f85;--line:#e6d8f0;--ok:#1f7a3d;--okbg:#dff3e5;--bad:#b3261e;--badbg:#fde4e1}'
  + '@media(prefers-color-scheme:dark){:root{--bg:#17101f;--card:#221832;--fg:#f3ecff;--muted:#b3a6c9;--line:#3d2d52;--ok:#7fdc9b;--okbg:#1d3a28;--bad:#ff9a90;--badbg:#4a1f1c}}'
  + '*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--fg);font:16px/1.5 ui-rounded,"SF Pro Rounded",-apple-system,system-ui,sans-serif}'
  + 'main{width:min(420px,100%);background:var(--card);border:1px solid var(--line);border-radius:20px;padding:40px 32px;text-align:center}'
  + '.icon{width:72px;height:72px;margin:0 auto 24px;border-radius:50%;display:grid;place-items:center;font-size:36px;font-weight:700;line-height:1}'
  + '.ok{background:var(--okbg);color:var(--ok)}.bad{background:var(--badbg);color:var(--bad)}'
  + 'h1{margin:0 0 8px;font-size:24px;line-height:1.25}p{margin:0;color:var(--muted)}.close{margin-top:24px;font-size:14px}';
const page = (title: string, body: string, ok: boolean) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_CSS}</style>`
  + `<body><main><div class="icon ${ok ? 'ok' : 'bad'}" role="img" aria-label="${ok ? 'Success' : 'Failed'}">${ok ? '&#10003;' : '&#10005;'}</div>`
  + `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p class="close">You can close this tab.</p></main></body></html>`;

/** One sign-in attempt (one browser tab): its own state, PKCE verifier, authorization URL and TTL. */
interface Attempt { state: string; serverId: string; cfg: ServerConfig; provider: OAuthClientProvider; verifier?: string; url?: string; at: number }

/** OAuth 2.1 + PKCE sign-in for HTTP connectors, via a loopback (`127.0.0.1`) redirect. One `OAuthFlows` instance
 * serves every connector: `providerFor` builds a per-server `OAuthClientProvider` for `ConnectorManager`, and
 * `handleCallback` completes the flow when the browser is redirected back to `/oauth/callback`. Attempts are
 * keyed by `state`, so two sign-in tabs for one server never share or overwrite each other's verifier. */
export class OAuthFlows {
  private readonly byState = new Map<string, Attempt>();
  /** The attempt a running `handleCallback` is completing, per server — `codeVerifier()` reads it first. */
  private readonly completing = new Map<string, Attempt>();

  constructor(
    private readonly deps: {
      secrets: SecretStore; redirectUrl: () => string; newState?: () => string; clock: () => number; authFn?: typeof sdkAuth;
      log?: Logger;
    },
  ) {}

  private fresh(a: Attempt | undefined): Attempt | undefined {
    return a && this.deps.clock() - a.at <= TTL_MS ? a : undefined;
  }

  private prune(): void {
    for (const [state, a] of this.byState) if (!this.fresh(a)) this.byState.delete(state);
  }

  /** The newest live attempt for a server (the one the SDK is currently writing into). */
  private latest(serverId: string): Attempt | undefined {
    let found: Attempt | undefined;
    for (const a of this.byState.values()) if (a.serverId === serverId && this.fresh(a) && (!found || a.at >= found.at)) found = a;
    return found;
  }

  /** The last authorization URL recorded for this server, if still within the 10-minute TTL. Studio polls this
   * after `POST /api/connectors/:id/auth` to show a "Continue sign-in" link. */
  pendingUrl(serverId: string): string | undefined {
    return this.latest(serverId)?.url;
  }

  providerFor(cfg: ServerConfig): OAuthClientProvider {
    const { secrets } = this.deps;
    const flows = this;
    const getJson = async <T>(name: string): Promise<T | undefined> => {
      const v = await secrets.get(secretKey(cfg.id, name));
      return v ? (JSON.parse(v) as T) : undefined;
    };
    const dropAttempts = (): void => {
      for (const [state, a] of flows.byState) if (a.serverId === cfg.id) flows.byState.delete(state);
      flows.completing.delete(cfg.id);
    };
    const provider: OAuthClientProvider = {
      get redirectUrl() { return flows.deps.redirectUrl(); },
      get clientMetadata(): OAuthClientMetadata {
        return { client_name: 'Coco', redirect_uris: [flows.deps.redirectUrl()], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
      },
      state: async () => {
        flows.prune();
        const state = (flows.deps.newState ?? (() => randomBytes(16).toString('hex')))();
        flows.byState.set(state, { state, serverId: cfg.id, cfg, provider, at: flows.deps.clock() });
        return state;
      },
      // cfg.oauthClientId (Slack has no dynamic client registration) always wins over anything saved from a
      // previous DCR run.
      clientInformation: async () =>
        cfg.oauthClientId ? { client_id: cfg.oauthClientId } : getJson<OAuthClientInformationMixed>('oauth_client'),
      saveClientInformation: async (info) => secrets.set(secretKey(cfg.id, 'oauth_client'), JSON.stringify(info)),
      tokens: async () => getJson<OAuthTokens>('oauth_tokens'),
      saveTokens: async (t) => secrets.set(secretKey(cfg.id, 'oauth_tokens'), JSON.stringify(t)),
      redirectToAuthorization: async (url) => {
        assertSafeAuthUrl(url); // server-supplied: never link Studio to http/file/custom-scheme or prod pages
        const a = flows.latest(cfg.id);
        if (a) a.url = url.toString();
      },
      saveCodeVerifier: async (v) => {
        const a = flows.latest(cfg.id);
        if (a) a.verifier = v;
      },
      codeVerifier: async () => {
        const v = (flows.completing.get(cfg.id) ?? flows.latest(cfg.id))?.verifier;
        if (!v) throw new Error('no pending sign-in');
        return v;
      },
      // Lets the SDK recover from a revoked refresh token or a stale dynamically-registered client: it clears the
      // stale piece and falls back to a fresh sign-in (needs_auth) instead of failing the same way forever.
      invalidateCredentials: async (scope) => {
        if (scope === 'all' || scope === 'tokens') await secrets.delete(secretKey(cfg.id, 'oauth_tokens'));
        if (scope === 'all' || scope === 'client') await secrets.delete(secretKey(cfg.id, 'oauth_client'));
        if (scope === 'all' || scope === 'verifier') dropAttempts();
      },
    };
    return provider;
  }

  /** Deletes a server's stored OAuth tokens and client registration (connector removed), so a later connector
   * reusing the same id can never send the old server's token to a new URL. */
  async forgetServer(serverId: string): Promise<void> {
    await this.deps.secrets.delete(secretKey(serverId, 'oauth_tokens'));
    await this.deps.secrets.delete(secretKey(serverId, 'oauth_client'));
    for (const [state, a] of this.byState) if (a.serverId === serverId) this.byState.delete(state);
    this.completing.delete(serverId);
  }

  /** Handles a GET to `/oauth/callback`. Every branch returns a small HTML page for the browser tab; the caller
   * (Task 11's `main`) also reconnects `serverId` when it is present, since a successful sign-in means the
   * connector can now finish `ensureConnected`. */
  async handleCallback(query: URLSearchParams): Promise<{ status: number; html: string; serverId?: string }> {
    this.prune();
    const state = query.get('state') ?? '';
    const attempt = this.fresh(this.byState.get(state));
    this.byState.delete(state); // single-use: gone whether it was valid or not
    if (!attempt) return { status: 400, html: page('Sign-in expired', 'This sign-in link is unknown or expired. Start again from Coco Studio.', false) };
    const error = query.get('error');
    if (error) return { status: 400, html: page('Sign-in failed', `The provider said: ${error.slice(0, 100)}`, false) };
    const code = query.get('code');
    if (!code) return { status: 400, html: page('Sign-in failed', 'No authorization code was returned.', false) };
    this.completing.set(attempt.serverId, attempt);
    try {
      await (this.deps.authFn ?? sdkAuth)(attempt.provider, { serverUrl: attempt.cfg.url!, authorizationCode: code, ...(this.deps.authFn ? {} : { fetchFn: safeFetch() }) });
    } catch (err) {
      const e = err as { name?: string; code?: string };
      this.deps.log?.warn('oauth_exchange_failed', { id: attempt.serverId, error: e.code ?? e.name ?? 'Error' });
      return { status: 400, html: page('Sign-in failed', 'Could not complete sign-in. Try again from Coco Studio.', false) };
    } finally {
      this.completing.delete(attempt.serverId);
    }
    return { status: 200, html: page(`Signed in to ${attempt.cfg.name}`, 'Coco can use it now.', true), serverId: attempt.serverId };
  }
}
