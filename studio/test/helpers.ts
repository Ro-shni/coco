import { vi } from 'vitest';

export type Route = (init?: RequestInit) => unknown;
export function mockFetch(routes: Record<string, Route>) {
  const calls: { key: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ error: 'nf' }), { status: 404 });
    return new Response(JSON.stringify(route(init)), { status: 200 });
  }));
  return calls;
}

export function connector(over: { state?: string; error?: string; enabled?: boolean; tools?: unknown[]; id?: string; name?: string } = {}) {
  const id = over.id ?? 'atlassian';
  return {
    config: { id, name: over.name ?? 'Atlassian', transport: 'http', url: 'https://mcp.atlassian.com/v1/mcp', args: [], envSecrets: [], headerSecrets: [], auth: 'oauth', enabled: over.enabled ?? true, source: 'catalog', readOnly: false },
    status: { id, state: over.state ?? 'connected', toolCount: 1, since: 0, ...(over.error ? { error: over.error } : {}) },
    tools: over.tools ?? [{ qualified: `${id}__createJiraIssue`, name: 'createJiraIssue', description: 'Create an issue', mode: 'confirm', reason: 'write_default' }],
  };
}
