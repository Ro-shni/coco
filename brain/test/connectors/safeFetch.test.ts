import { describe, expect, it, vi } from 'vitest';
import { assertSafeAuthUrl, safeFetch } from '../../src/connectors/safeFetch.js';

describe('assertSafeAuthUrl', () => {
  it.each([
    ['https://auth.atlassian.com/authorize?x=1', true],
    ['http://auth.example.com/authorize', false],
    ['file:///etc/passwd', false],
    ['smb://host/share', false],
    ['myapp://callback', false],
    ['https://sso.prd.meesho.int/authorize', false],
  ])('%s → %s', (url, ok) => {
    if (ok) expect(() => assertSafeAuthUrl(new URL(url))).not.toThrow();
    else expect(() => assertSafeAuthUrl(new URL(url))).toThrow();
  });
});

describe('safeFetch', () => {
  it('refuses production hosts before any request is made', async () => {
    const inner = vi.fn(async () => new Response('x'));
    await expect(safeFetch(inner)('https://a.int.meesho.int/.well-known/oauth-authorization-server')).rejects.toThrow(/production host/);
    expect(inner).not.toHaveBeenCalled();
  });

  it('passes other requests through', async () => {
    const inner = vi.fn(async () => new Response('ok'));
    const r = await safeFetch(inner)(new URL('https://mcp.atlassian.com/v1/mcp'), { method: 'POST' });
    expect(await r.text()).toBe('ok');
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
