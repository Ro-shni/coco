import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Home } from '../src/tabs/Home';

describe('Home tab', () => {
  it('shows brain, model and connector health', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ brain: 'ok', ollama: false, models: { main: 'qwen3.5:9b', vision: 'qwen3.5:9b' }, connectors: { total: 3, connected: 2, error: 1 } }))));
    render(<Home />);
    expect(await screen.findByText('qwen3.5:9b')).toBeTruthy();
    expect(screen.getByText(/Ollama is not reachable/)).toBeTruthy();
    expect(screen.getByText('2 of 3 connected · 1 need attention')).toBeTruthy();
  });

  it('shows an error message instead of "Loading…" when the health check fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 })));
    render(<Home />);
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain("Couldn't load Home");
    expect(screen.queryByText('Loading…')).toBeNull();
  });
});

describe('Home getting started', () => {
  it('shows a checklist only when there are no connectors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ brain: 'ok', ollama: true, models: { main: 'm', vision: 'm' }, connectors: { total: 0, connected: 0, error: 0 } }))));
    render(<Home />);
    expect(await screen.findByText('Getting started')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import from this Mac' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Try the Playground' })).toBeTruthy();
  });
});
