import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AddConnectorModal } from '../src/components/AddConnectorModal';
import { mockFetch } from './helpers';

const discovery = {
  scanDirs: [],
  servers: [
    { key: 'k1', name: 'kubectl-readonly', transport: 'stdio', command: '/opt/py', args: ['-m', 'kubectl_mcp_tool', '--read-only'], envNames: ['KUBECONFIG'], headerNames: [], foundIn: ['/Users/me/.claude.json'], status: 'importable', readOnly: true },
    { key: 'k2', name: 'bifrost', transport: 'http', url: 'http://ai-gateway.prd.meesho.int/mcp', args: [], envNames: [], headerNames: ['Authorization'], foundIn: ['/Users/me/.claude.json'], status: 'blocked_host', readOnly: false },
  ],
};
const base = { 'GET /api/discovery': () => discovery, 'GET /api/catalog': () => [] };

async function open(routes: Record<string, () => unknown> = {}, tab: 'catalog' | 'found' | 'custom' = 'found') {
  const calls = mockFetch({ ...base, ...routes });
  const onAdded = vi.fn();
  render(<AddConnectorModal initialTab={tab} onClose={() => undefined} onAdded={onAdded} />);
  return { calls, onAdded };
}

describe('Add connector modal', () => {
  it('has Catalog, Found on this Mac and Custom tabs', async () => {
    await open({}, 'catalog');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Catalog', 'Found on this Mac', 'Custom']);
  });

  it('blocked prod hosts are greyed with a reason and cannot be imported', async () => {
    await open();
    const bifrost = await screen.findByTestId('discovered-bifrost');
    expect(within(bifrost).getByText(/Blocked: production host/)).toBeTruthy();
    expect(within(bifrost).queryByRole('button', { name: /import/i })).toBeNull();
  });

  it('import shows the exact command and env names before running it', async () => {
    const { calls, onAdded } = await open({ 'POST /api/discovery/import': () => ({ id: 'kubectl-readonly' }) });
    const row = await screen.findByTestId('discovered-kubectl-readonly');
    await userEvent.click(within(row).getByRole('button', { name: /import/i }));
    const dialog = screen.getByRole('dialog', { name: 'Import kubectl-readonly' });
    expect(within(dialog).getByText('/opt/py -m kubectl_mcp_tool --read-only')).toBeTruthy();
    expect(within(dialog).getByText('KUBECONFIG')).toBeTruthy();
    expect(within(dialog).getByText('/Users/me/.claude.json')).toBeTruthy();
    expect(calls.some((c) => c.key === 'POST /api/discovery/import')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run this server' }));
    await waitFor(() => expect(calls.find((c) => c.key === 'POST /api/discovery/import')?.body).toEqual({ key: 'k1', confirm: true }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('kubectl-readonly'));
  });

  it('adds a scan folder from the Found tab', async () => {
    const { calls } = await open({ 'POST /api/settings/scan-dirs': () => ({ ok: true }) });
    await userEvent.type(await screen.findByLabelText('Folder to scan for .mcp.json'), '/Users/me/code');
    await userEvent.click(screen.getByRole('button', { name: 'Add folder to scan' }));
    await waitFor(() => expect(calls.find((c) => c.key === 'POST /api/settings/scan-dirs')?.body).toEqual({ dir: '/Users/me/code' }));
  });

  it('a custom connector shows the exact command and posts only after Run this server', async () => {
    const { calls } = await open({ 'POST /api/connectors': () => ({ id: 'my-tool' }) }, 'custom');
    await userEvent.type(screen.getByLabelText('Connector name'), 'my-tool');
    await userEvent.type(screen.getByLabelText('Command'), '/usr/bin/my-tool');
    await userEvent.type(screen.getByLabelText('Arguments, one per line'), '--flag{Enter}value');
    await userEvent.click(screen.getByRole('button', { name: 'Add env var' }));
    await userEvent.type(screen.getByLabelText('env var name 1'), 'API_KEY');
    await userEvent.type(screen.getByLabelText('env var value 1'), 'super-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Add custom connector' }));
    const dialog = screen.getByRole('dialog', { name: 'Add my-tool' });
    expect(within(dialog).getByText('/usr/bin/my-tool --flag value')).toBeTruthy();
    expect(within(dialog).queryByText('super-secret')).toBeNull();
    expect(calls.some((c) => c.key === 'POST /api/connectors')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run this server' }));
    await waitFor(() => expect(calls.find((c) => c.key === 'POST /api/connectors')?.body).toEqual({
      name: 'my-tool', transport: 'stdio', confirm: true, command: '/usr/bin/my-tool', args: ['--flag', 'value'], env: { API_KEY: 'super-secret' },
    }));
  });
});
