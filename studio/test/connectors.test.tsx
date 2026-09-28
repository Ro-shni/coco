import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Connectors } from '../src/tabs/Connectors';

type Route = (init?: RequestInit) => unknown;
function mockFetch(routes: Record<string, Route>) {
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

const discovery = {
  scanDirs: [],
  servers: [
    { key: 'k1', name: 'kubectl-readonly', transport: 'stdio', command: '/opt/py', args: ['-m', 'kubectl_mcp_tool', '--read-only'], envNames: ['KUBECONFIG'], headerNames: [], foundIn: ['/Users/me/.claude.json'], status: 'importable', readOnly: true },
    { key: 'k2', name: 'bifrost', transport: 'http', url: 'http://ai-gateway.prd.meesho.int/mcp', args: [], envNames: [], headerNames: ['Authorization'], foundIn: ['/Users/me/.claude.json'], status: 'blocked_host', readOnly: false },
  ],
};
const base = {
  'GET /api/connectors': () => [],
  'GET /api/discovery': () => discovery,
  'GET /api/catalog': () => [],
};

function atlassianConnector(overrides: { toolMode?: string } = {}) {
  return {
    config: { id: 'atlassian', name: 'Atlassian', transport: 'http', url: 'https://mcp.atlassian.com/v1/mcp', args: [], envSecrets: [], headerSecrets: [], auth: 'oauth', enabled: true, source: 'catalog', readOnly: false },
    status: { id: 'atlassian', state: 'connected', toolCount: 1, since: 0 },
    tools: [{ qualified: 'atlassian__createJiraIssue', name: 'createJiraIssue', description: 'Create', mode: overrides.toolMode ?? 'confirm', reason: 'write_default' }],
  };
}

describe('Connectors tab', () => {
  it('shows discovered servers; blocked prod hosts cannot be imported', async () => {
    mockFetch(base);
    render(<Connectors />);
    const bifrost = await screen.findByTestId('discovered-bifrost');
    expect(within(bifrost).getByText('Blocked: production host')).toBeTruthy();
    expect(within(bifrost).queryByRole('button', { name: /import/i })).toBeNull();
  });

  it('import shows the exact command and env names before running it', async () => {
    const calls = mockFetch({ ...base, 'POST /api/discovery/import': () => ({ id: 'kubectl-readonly' }) });
    render(<Connectors />);
    const row = await screen.findByTestId('discovered-kubectl-readonly');
    await userEvent.click(within(row).getByRole('button', { name: /import/i }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('/opt/py -m kubectl_mcp_tool --read-only')).toBeTruthy();
    expect(within(dialog).getByText('KUBECONFIG')).toBeTruthy();
    expect(within(dialog).getByText('/Users/me/.claude.json')).toBeTruthy();
    expect(calls.some((c) => c.key === 'POST /api/discovery/import')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run this server' }));
    await waitFor(() => expect(calls.find((c) => c.key === 'POST /api/discovery/import')?.body).toEqual({ key: 'k1', confirm: true }));
  });

  it('changing a tool mode PUTs it', async () => {
    const calls = mockFetch({
      ...base,
      'GET /api/connectors': () => [{
        config: { id: 'atlassian', name: 'Atlassian', transport: 'http', url: 'https://mcp.atlassian.com/v1/mcp', args: [], envSecrets: [], headerSecrets: [], auth: 'oauth', enabled: true, source: 'catalog', readOnly: false },
        status: { id: 'atlassian', state: 'connected', toolCount: 1, since: 0 },
        tools: [{ qualified: 'atlassian__createJiraIssue', name: 'createJiraIssue', description: 'Create', mode: 'confirm', reason: 'write_default' }],
      }],
      'PUT /api/tools/atlassian__createJiraIssue/mode': () => ({ ok: true }),
    });
    render(<Connectors />);
    const select = await screen.findByLabelText('Permission for createJiraIssue');
    await userEvent.selectOptions(select, 'off');
    await waitFor(() => expect(calls.find((c) => c.key === 'PUT /api/tools/atlassian__createJiraIssue/mode')?.body).toEqual({ mode: 'off' }));
  });

  it('needs_auth shows Sign in and then a continue link', async () => {
    mockFetch({
      ...base,
      'GET /api/connectors': () => [{
        config: { id: 'atlassian', name: 'Atlassian', transport: 'http', url: 'https://mcp.atlassian.com/v1/mcp', args: [], envSecrets: [], headerSecrets: [], auth: 'oauth', enabled: true, source: 'catalog', readOnly: false },
        status: { id: 'atlassian', state: 'needs_auth', toolCount: 0, since: 0 }, tools: [],
      }],
      'POST /api/connectors/atlassian/auth': () => ({ state: 'needs_auth', authorizationUrl: 'https://auth.atlassian.com/authorize?x=1' }),
    });
    render(<Connectors />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    const link = await screen.findByRole('link', { name: /continue sign-in/i });
    expect(link.getAttribute('href')).toBe('https://auth.atlassian.com/authorize?x=1');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('a failed mode PUT reverts the select and shows an error inline (no route for the PUT => 404)', async () => {
    const calls = mockFetch({ ...base, 'GET /api/connectors': () => [atlassianConnector()] });
    render(<Connectors />);
    const select = (await screen.findByLabelText('Permission for createJiraIssue')) as HTMLSelectElement;
    expect(select.value).toBe('confirm');
    await userEvent.selectOptions(select, 'off');
    await waitFor(() => expect(select.value).toBe('confirm')); // reverted after the failed PUT
    expect(await screen.findByText(/Couldn't change permission/)).toBeTruthy();
    expect(calls.some((c) => c.key === 'PUT /api/tools/atlassian__createJiraIssue/mode')).toBe(true);
  });

  it('a failed Reconnect shows the shared error banner (no route for reconnect => 404)', async () => {
    mockFetch({ ...base, 'GET /api/connectors': () => [atlassianConnector()] });
    render(<Connectors />);
    const card = await screen.findByTestId('connector-atlassian');
    await userEvent.click(within(card).getByRole('button', { name: 'Reconnect' }));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('nf'); // the mock's default 404 error body
  });

  it('the Enabled toggle POSTs {enabled:false}', async () => {
    const calls = mockFetch({
      ...base,
      'GET /api/connectors': () => [atlassianConnector()],
      'POST /api/connectors/atlassian/enabled': () => ({ ok: true }),
    });
    render(<Connectors />);
    const toggle = await screen.findByLabelText('Enabled for Atlassian');
    await userEvent.click(toggle);
    await waitFor(() => expect(calls.find((c) => c.key === 'POST /api/connectors/atlassian/enabled')?.body).toEqual({ enabled: false }));
  });

  it('adding a custom connector shows the exact command and posts the right body only after Run this server', async () => {
    const calls = mockFetch({ ...base, 'POST /api/connectors': () => ({ id: 'my-tool' }) });
    render(<Connectors />);
    await screen.findByRole('heading', { name: 'Add custom connector' });

    await userEvent.type(screen.getByLabelText('Connector name'), 'my-tool');
    await userEvent.type(screen.getByLabelText('Command'), '/usr/bin/my-tool');
    await userEvent.type(screen.getByLabelText('Arguments, one per line'), '--flag{Enter}value');
    await userEvent.click(screen.getByRole('button', { name: 'Add env var' }));
    await userEvent.type(screen.getByLabelText('env var name 1'), 'API_KEY');
    await userEvent.type(screen.getByLabelText('env var value 1'), 'super-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Add custom connector' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('/usr/bin/my-tool --flag value')).toBeTruthy();
    expect(within(dialog).getByText('API_KEY')).toBeTruthy();
    expect(within(dialog).queryByText('super-secret')).toBeNull(); // credential values are never shown
    expect(calls.some((c) => c.key === 'POST /api/connectors')).toBe(false);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Run this server' }));
    await waitFor(() => expect(calls.find((c) => c.key === 'POST /api/connectors')?.body).toEqual({
      name: 'my-tool', transport: 'stdio', confirm: true,
      command: '/usr/bin/my-tool', args: ['--flag', 'value'],
      env: { API_KEY: 'super-secret' },
    }));
  });
});
