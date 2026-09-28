import { randomBytes } from 'node:crypto';
import { auth as sdkAuth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { secretKey, type SecretStore } from './secrets.js';
import type { ServerConfig } from './types.js';

const TTL_MS = 10 * 60_000;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:-apple-system;padding:40px"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p></body>`;

interface Flow { serverId: string; cfg: ServerConfig; provider: OAuthClientProvider; verifier?: string; url?: string; at: number }

/** OAuth 2.1 + PKCE sign-in for HTTP connectors, via a loopback (`127.0.0.1`) redirect. One `OAuthFlows` instance
 * serves every connector: `providerFor` builds a per-server `OAuthClientProvider` for `ConnectorManager`, and
 * `handleCallback` completes the flow when the browser is redirected back to `/oauth/callback`. */
export class OAuthFlows {
  private readonly byState = new Map<string, Flow>();
  private readonly byServer = new Map<string, Flow>();

  constructor(
    private readonly deps: {
      secrets: SecretStore; redirectUrl: () => string; newState?: () => string; clock: () => number; authFn?: typeof sdkAuth;
    },
  ) {}

  private fresh(f: Flow | undefined): Flow | undefined {
    return f && this.deps.clock() - f.at <= TTL_MS ? f : undefined;
  }

  /** The last authorization URL recorded for this server, if still within the 10-minute TTL. Studio polls this
   * after `POST /api/connectors/:id/auth` to show a "Continue sign-in" link. */
  pendingUrl(serverId: string): string | undefined {
    return this.fresh(this.byServer.get(serverId))?.url;
  }

  providerFor(cfg: ServerConfig): OAuthClientProvider {
    const { secrets } = this.deps;
    const flows = this;
    const getJson = async <T>(name: string): Promise<T | undefined> => {
      const v = await secrets.get(secretKey(cfg.id, name));
      return v ? (JSON.parse(v) as T) : undefined;
    };
    const flowFor = (): Flow => {
      const existing = flows.fresh(flows.byServer.get(cfg.id));
      if (existing) return existing;
      const f: Flow = { serverId: cfg.id, cfg, provider, at: flows.deps.clock() };
      flows.byServer.set(cfg.id, f);
      return f;
    };
    const provider: OAuthClientProvider = {
      get redirectUrl() { return flows.deps.redirectUrl(); },
      get clientMetadata(): OAuthClientMetadata {
        return { client_name: 'Coco', redirect_uris: [flows.deps.redirectUrl()], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
      },
      state: async () => {
        const state = (flows.deps.newState ?? (() => randomBytes(16).toString('hex')))();
        const f = flowFor();
        f.at = flows.deps.clock();
        flows.byState.set(state, f);
        return state;
      },
      // cfg.oauthClientId (Slack has no dynamic client registration) always wins over anything saved from a
      // previous DCR run.
      clientInformation: async () =>
        cfg.oauthClientId ? { client_id: cfg.oauthClientId } : getJson<OAuthClientInformationMixed>('oauth_client'),
      saveClientInformation: async (info) => secrets.set(secretKey(cfg.id, 'oauth_client'), JSON.stringify(info)),
      tokens: async () => getJson<OAuthTokens>('oauth_tokens'),
      saveTokens: async (t) => secrets.set(secretKey(cfg.id, 'oauth_tokens'), JSON.stringify(t)),
      redirectToAuthorization: async (url) => { flowFor().url = url.toString(); },
      saveCodeVerifier: async (v) => { flowFor().verifier = v; },
      codeVerifier: async () => {
        const v = flows.fresh(flows.byServer.get(cfg.id))?.verifier;
        if (!v) throw new Error('no pending sign-in');
        return v;
      },
    };
    return provider;
  }

  /** Handles a GET to `/oauth/callback`. Every branch returns a small HTML page for the browser tab; the caller
   * (Task 11's `main`) also reconnects `serverId` when it is present, since a successful sign-in means the
   * connector can now finish `ensureConnected`. */
  async handleCallback(query: URLSearchParams): Promise<{ status: number; html: string; serverId?: string }> {
    const state = query.get('state') ?? '';
    const flow = this.fresh(this.byState.get(state));
    this.byState.delete(state); // single-use: gone whether it was valid or not
    if (!flow) return { status: 400, html: page('Sign-in expired', 'This sign-in link is unknown or expired. Start again from Coco Studio.') };
    const error = query.get('error');
    if (error) return { status: 400, html: page('Sign-in failed', `The provider said: ${error.slice(0, 100)}`) };
    const code = query.get('code');
    if (!code) return { status: 400, html: page('Sign-in failed', 'No authorization code was returned.') };
    try {
      await (this.deps.authFn ?? sdkAuth)(flow.provider, { serverUrl: flow.cfg.url!, authorizationCode: code });
    } catch {
      return { status: 400, html: page('Sign-in failed', 'Could not complete sign-in. Try again from Coco Studio.') };
    }
    this.byServer.delete(flow.serverId);
    return { status: 200, html: page(`Signed in to ${flow.cfg.name}`, 'You can close this tab.'), serverId: flow.serverId };
  }
}
