import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Connectors } from '../src/tabs/Connectors';
import type { ConnectorView } from '../src/types';
import { connector, mockFetch } from './helpers';

function view(c: ReturnType<typeof connector>, reload = vi.fn(async () => undefined)) {
  const data = { connectors: [c as unknown as ConnectorView], loaded: true, reload };
  return { ...render(<Connectors data={data} id={c.config.id} />), reload };
}

describe('Connector detail', () => {
  it('connected: no primary action; changing a permission PUTs the mode', async () => {
    const calls = mockFetch({ 'PUT /api/tools/atlassian__createJiraIssue/mode': () => ({ ok: true }) });
    view(connector());
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.getByText('Connected')).toBeTruthy();
    const group = screen.getByRole('radiogroup', { name: 'Permission for createJiraIssue' });
    expect((within(group).getByLabelText('Ask first') as HTMLInputElement).checked).toBe(true);
    await userEvent.click(within(group).getByLabelText('Off'));
    await waitFor(() => expect(calls.find((c) => c.key === 'PUT /api/tools/atlassian__createJiraIssue/mode')?.body).toEqual({ mode: 'off' }));
  });

  it('a failed permission change reverts and shows an inline error', async () => {
    mockFetch({});
    view(connector());
    const group = screen.getByRole('radiogroup', { name: 'Permission for createJiraIssue' });
    await userEvent.click(within(group).getByLabelText('Off'));
    expect(await screen.findByText(/Couldn't change permission/)).toBeTruthy();
    expect((within(group).getByLabelText('Ask first') as HTMLInputElement).checked).toBe(true);
  });

  it('needs_auth: Sign in shows a prominent continue link', async () => {
    mockFetch({ 'POST /api/connectors/atlassian/auth': () => ({ state: 'needs_auth', authorizationUrl: 'https://auth.atlassian.com/authorize?x=1' }) });
    view(connector({ state: 'needs_auth', tools: [] }));
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const link = await screen.findByRole('link', { name: /continue sign-in in your browser/i });
    expect(link.getAttribute('href')).toBe('https://auth.atlassian.com/authorize?x=1');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('error: shows the reason as a sentence and a Reconnect primary action; failures reach the banner', async () => {
    mockFetch({});
    view(connector({ state: 'error', error: 'spawn ENOENT', tools: [] }));
    expect(screen.getByText(/couldn't connect to Atlassian\. spawn ENOENT\./)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('nf');
  });

  it('disconnected: Connect posts reconnect', async () => {
    const calls = mockFetch({ 'POST /api/connectors/atlassian/reconnect': () => ({ ok: true }) });
    view(connector({ state: 'disconnected', tools: [] }));
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'POST /api/connectors/atlassian/reconnect')).toBe(true));
  });

  it('the menu disables the connector', async () => {
    const calls = mockFetch({ 'POST /api/connectors/atlassian/enabled': () => ({ ok: true }) });
    view(connector());
    await userEvent.click(screen.getByRole('button', { name: 'More actions for Atlassian' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Disable' }));
    await waitFor(() => expect(calls.find((c) => c.key === 'POST /api/connectors/atlassian/enabled')?.body).toEqual({ enabled: false }));
  });

  it('Remove asks for confirmation before deleting', async () => {
    const calls = mockFetch({ 'DELETE /api/connectors/atlassian': () => ({ ok: true }) });
    view(connector());
    await userEvent.click(screen.getByRole('button', { name: 'More actions for Atlassian' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
    expect(calls.some((c) => c.key === 'DELETE /api/connectors/atlassian')).toBe(false);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove connector' }));
    await waitFor(() => expect(calls.some((c) => c.key === 'DELETE /api/connectors/atlassian')).toBe(true));
  });

  it('shows a tool filter only when there are more than 8 tools', async () => {
    const tools = Array.from({ length: 10 }, (_, i) => ({ qualified: `atlassian__t${i}`, name: `tool${i}`, description: i === 3 ? 'needle here' : 'x', mode: 'auto', reason: '' }));
    mockFetch({});
    view(connector({ tools }));
    await userEvent.type(screen.getByLabelText('Filter tools'), 'needle');
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(1);
  });

  it('few tools: no filter box', () => {
    mockFetch({});
    view(connector());
    expect(screen.queryByLabelText('Filter tools')).toBeNull();
  });
});

describe('Try it', () => {
  const tools = [{ qualified: 'atlassian__search', name: 'search', description: 'Search', mode: 'auto', reason: '',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer' } } } }];

  it('generates a form from the schema, posts typed args and pretty-prints JSON results', async () => {
    const calls = mockFetch({ 'POST /api/tools/atlassian__search/test': () => ({ ok: true, text: '{"hits":[1,2]}', ms: 42 }) });
    view(connector({ tools }));
    await userEvent.click(screen.getByRole('button', { name: /try it/i }));
    const run = screen.getByRole('button', { name: 'Run' });
    await userEvent.type(screen.getByLabelText(/^query/), 'wordle');
    await userEvent.type(screen.getByLabelText('limit'), '3');
    await userEvent.click(run);
    await waitFor(() => expect(calls.find((c) => c.key === 'POST /api/tools/atlassian__search/test')?.body).toEqual({ args: { query: 'wordle', limit: 3 } }));
    expect(await screen.findByText('ok')).toBeTruthy();
    expect(screen.getByText('42 ms')).toBeTruthy();
    expect(screen.getByText(/"hits": \[/)).toBeTruthy();
  });

  it('blocks Run with a clear message when a required field is empty', async () => {
    const calls = mockFetch({});
    view(connector({ tools }));
    await userEvent.click(screen.getByRole('button', { name: /try it/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect((await screen.findByRole('alert')).textContent).toBe('query is required.');
    expect(calls.length).toBe(0);
  });

  it('shows an error badge when the call fails', async () => {
    mockFetch({ 'POST /api/tools/atlassian__search/test': () => ({ ok: false, text: 'denied by server', ms: 7 }) });
    view(connector({ tools }));
    await userEvent.click(screen.getByRole('button', { name: /try it/i }));
    await userEvent.type(screen.getByLabelText(/^query/), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('error')).toBeTruthy();
    expect(screen.getByText('denied by server')).toBeTruthy();
  });
});
