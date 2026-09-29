import { describe, expect, it, vi } from 'vitest';
import { OAuthFlows } from '../../src/connectors/oauth.js';
import { MemorySecretStore, secretKey } from '../../src/connectors/secrets.js';
import type { ServerConfig } from '../../src/connectors/types.js';

const cfg = (over: Partial<ServerConfig> = {}): ServerConfig => ({
  id: 'atlassian', name: 'Atlassian', transport: 'http', url: 'https://mcp.atlassian.com/v1/mcp', args: [], envSecrets: [], headerSecrets: [],
  auth: 'oauth', enabled: true, source: 'catalog', readOnly: false, ...over,
});

function setup() {
  const secrets = new MemorySecretStore();
  let now = 0;
  const authFn = vi.fn(async () => 'AUTHORIZED' as const);
  const flows = new OAuthFlows({ secrets, redirectUrl: () => 'http://127.0.0.1:5555/oauth/callback', newState: () => 'state-1', clock: () => now, authFn });
  return { flows, secrets, authFn, advance: (ms: number) => (now += ms) };
}

describe('OAuthFlows provider', () => {
  it('advertises Coco as a public loopback client', () => {
    const p = setup().flows.providerFor(cfg());
    expect(p.redirectUrl).toBe('http://127.0.0.1:5555/oauth/callback');
    expect(p.clientMetadata).toMatchObject({ client_name: 'Coco', redirect_uris: ['http://127.0.0.1:5555/oauth/callback'], token_endpoint_auth_method: 'none' });
  });

  it('persists client info and tokens in the secret store as JSON', async () => {
    const s = setup();
    const p = s.flows.providerFor(cfg());
    await p.saveClientInformation!({ client_id: 'dyn-1' });
    await p.saveTokens({ access_token: 'at', token_type: 'Bearer', refresh_token: 'rt' });
    expect(JSON.parse((await s.secrets.get(secretKey('atlassian', 'oauth_tokens')))!)).toMatchObject({ access_token: 'at' });
    expect(await s.flows.providerFor(cfg()).clientInformation()).toEqual({ client_id: 'dyn-1' });
    expect(await s.flows.providerFor(cfg()).tokens()).toMatchObject({ refresh_token: 'rt' });
  });

  it('uses a configured Client ID instead of dynamic registration (Slack)', async () => {
    const p = setup().flows.providerFor(cfg({ id: 'slack', url: 'https://mcp.slack.com/mcp', oauthClientId: '123.456' }));
    expect(await p.clientInformation()).toEqual({ client_id: '123.456' });
  });

  it('records the authorization URL for Studio to show', async () => {
    const s = setup();
    const p = s.flows.providerFor(cfg());
    await p.state!();
    await p.redirectToAuthorization(new URL('https://auth.atlassian.com/authorize?x=1&state=state-1'));
    expect(s.flows.pendingUrl('atlassian')).toBe('https://auth.atlassian.com/authorize?x=1&state=state-1');
    s.advance(11 * 60_000);
    expect(s.flows.pendingUrl('atlassian')).toBeUndefined();
  });
});

describe('OAuthFlows.handleCallback', () => {
  it('rejects unknown state', async () => {
    const r = await setup().flows.handleCallback(new URLSearchParams('code=c&state=nope'));
    expect(r.status).toBe(400);
  });

  it('shows (escaped) provider errors', async () => {
    const s = setup();
    const p = s.flows.providerFor(cfg());
    await p.state!();
    const r = await s.flows.handleCallback(new URLSearchParams('error=<script>x</script>&state=state-1'));
    expect(r.status).toBe(400);
    expect(r.html).not.toContain('<script>');
  });

  it('exchanges the code via the SDK auth() and returns the server id', async () => {
    const s = setup();
    const p = s.flows.providerFor(cfg());
    await p.state!();
    await p.saveCodeVerifier('ver');
    const r = await s.flows.handleCallback(new URLSearchParams('code=abc&state=state-1'));
    expect(r).toMatchObject({ status: 200, serverId: 'atlassian' });
    expect(r.html).toContain('Signed in to Atlassian');
    expect(s.authFn).toHaveBeenCalledWith(expect.anything(), { serverUrl: 'https://mcp.atlassian.com/v1/mcp', authorizationCode: 'abc' });
    // state is single-use
    expect((await s.flows.handleCallback(new URLSearchParams('code=abc&state=state-1'))).status).toBe(400);
  });
});

describe('OAuthFlows fix round 1', () => {
  function setup2(states: string[]) {
    const secrets = new MemorySecretStore();
    let now = 0;
    const seenVerifiers: string[] = [];
    const authFn = vi.fn(async (p: { codeVerifier(): Promise<string> }) => {
      seenVerifiers.push(await p.codeVerifier());
      return 'AUTHORIZED' as const;
    });
    const logged: { event: string; data?: Record<string, unknown> }[] = [];
    const log = { info: () => undefined, warn: (event: string, data?: Record<string, unknown>) => logged.push({ event, data }), error: () => undefined };
    const flows = new OAuthFlows({
      secrets, redirectUrl: () => 'http://127.0.0.1:47823/oauth/callback', newState: () => states.shift()!, clock: () => now,
      authFn: authFn as never, log,
    });
    return { flows, secrets, authFn, seenVerifiers, logged, advance: (ms: number) => (now += ms) };
  }

  it('I3: the older of two sign-in tabs completes with its own verifier', async () => {
    const s = setup2(['s1', 's2']);
    const p = s.flows.providerFor(cfg());
    await p.state!();
    await p.saveCodeVerifier('v1');
    await p.redirectToAuthorization(new URL('https://auth.example/authorize?state=s1'));
    await p.state!();
    await p.saveCodeVerifier('v2');
    await p.redirectToAuthorization(new URL('https://auth.example/authorize?state=s2'));
    const r = await s.flows.handleCallback(new URLSearchParams('code=c&state=s1'));
    expect(r.status).toBe(200);
    expect(s.seenVerifiers).toEqual(['v1']);
    expect(s.flows.pendingUrl('atlassian')).toBe('https://auth.example/authorize?state=s2');
  });

  it('I3: a newer attempt does not extend an older attempt’s TTL', async () => {
    const s = setup2(['s1', 's2']);
    const p = s.flows.providerFor(cfg());
    await p.state!();
    await p.saveCodeVerifier('v1');
    s.advance(9 * 60_000);
    await p.state!();
    await p.saveCodeVerifier('v2');
    s.advance(2 * 60_000);
    expect((await s.flows.handleCallback(new URLSearchParams('code=c&state=s1'))).status).toBe(400);
    expect((await s.flows.handleCallback(new URLSearchParams('code=c&state=s2'))).status).toBe(200);
    expect(s.seenVerifiers).toEqual(['v2']);
  });

  it('I2: invalidateCredentials clears the requested scope', async () => {
    const s = setup2(['s1']);
    const p = s.flows.providerFor(cfg());
    await p.saveClientInformation!({ client_id: 'dyn-1' });
    await p.saveTokens({ access_token: 'at', token_type: 'Bearer' });
    await p.invalidateCredentials!('tokens');
    expect(await p.tokens()).toBeUndefined();
    expect(await p.clientInformation()).toEqual({ client_id: 'dyn-1' });
    await p.saveTokens({ access_token: 'at', token_type: 'Bearer' });
    await p.state!();
    await p.saveCodeVerifier('v1');
    await p.invalidateCredentials!('all');
    expect(await p.tokens()).toBeUndefined();
    expect(await p.clientInformation()).toBeUndefined();
    await expect(p.codeVerifier()).rejects.toThrow();
  });

  it('I5: logs exchange failures by class only', async () => {
    const s = setup2(['s1']);
    s.authFn.mockRejectedValueOnce(Object.assign(new Error('https://auth.example/token?secret=x failed'), { name: 'InvalidGrantError' }));
    const p = s.flows.providerFor(cfg());
    await p.state!();
    await p.saveCodeVerifier('v1');
    expect((await s.flows.handleCallback(new URLSearchParams('code=c&state=s1'))).status).toBe(400);
    expect(s.logged).toEqual([{ event: 'oauth_exchange_failed', data: { id: 'atlassian', error: 'InvalidGrantError' } }]);
  });
});

describe('OAuthFlows security', () => {
  it('refuses a non-https or production-host authorization URL', async () => {
    const flows = new OAuthFlows({ secrets: new MemorySecretStore(), redirectUrl: () => 'http://127.0.0.1:47823/oauth/callback', newState: () => 's1', clock: () => 0 });
    const p = flows.providerFor(cfg());
    await p.state!();
    await expect(p.redirectToAuthorization(new URL('http://phish.example/login'))).rejects.toThrow();
    await expect(p.redirectToAuthorization(new URL('https://x.prd.meesho.int/authorize'))).rejects.toThrow();
    expect(flows.pendingUrl('atlassian')).toBeUndefined();
  });

  it('forgetServer removes stored OAuth tokens and client', async () => {
    const secrets = new MemorySecretStore();
    const flows = new OAuthFlows({ secrets, redirectUrl: () => 'http://127.0.0.1:47823/oauth/callback', clock: () => 0 });
    const p = flows.providerFor(cfg());
    await p.saveTokens({ access_token: 'at', token_type: 'Bearer' });
    await p.saveClientInformation!({ client_id: 'c' });
    await flows.forgetServer('atlassian');
    expect(await secrets.get(secretKey('atlassian', 'oauth_tokens'))).toBeUndefined();
    expect(await secrets.get(secretKey('atlassian', 'oauth_client'))).toBeUndefined();
  });
});
