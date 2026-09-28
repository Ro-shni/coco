import { randomBytes } from 'node:crypto';
import { auth as sdkAuth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Logger } from '../logger.js';
import { secretKey, type SecretStore } from './secrets.js';
import type { ServerConfig } from './types.js';

const TTL_MS = 10 * 60_000;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:-apple-system;padding:40px"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p></body>`;

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

  /** Handles a GET to `/oauth/callback`. Every branch returns a small HTML page for the browser tab; the caller
   * (Task 11's `main`) also reconnects `serverId` when it is present, since a successful sign-in means the
   * connector can now finish `ensureConnected`. */
  async handleCallback(query: URLSearchParams): Promise<{ status: number; html: string; serverId?: string }> {
    this.prune();
    const state = query.get('state') ?? '';
    const attempt = this.fresh(this.byState.get(state));
    this.byState.delete(state); // single-use: gone whether it was valid or not
    if (!attempt) return { status: 400, html: page('Sign-in expired', 'This sign-in link is unknown or expired. Start again from Coco Studio.') };
    const error = query.get('error');
    if (error) return { status: 400, html: page('Sign-in failed', `The provider said: ${error.slice(0, 100)}`) };
    const code = query.get('code');
    if (!code) return { status: 400, html: page('Sign-in failed', 'No authorization code was returned.') };
    this.completing.set(attempt.serverId, attempt);
    try {
      await (this.deps.authFn ?? sdkAuth)(attempt.provider, { serverUrl: attempt.cfg.url!, authorizationCode: code });
    } catch (err) {
      const e = err as { name?: string; code?: string };
      this.deps.log?.warn('oauth_exchange_failed', { id: attempt.serverId, error: e.code ?? e.name ?? 'Error' });
      return { status: 400, html: page('Sign-in failed', 'Could not complete sign-in. Try again from Coco Studio.') };
    } finally {
      this.completing.delete(attempt.serverId);
    }
    return { status: 200, html: page(`Signed in to ${attempt.cfg.name}`, 'You can close this tab.'), serverId: attempt.serverId };
  }
}
