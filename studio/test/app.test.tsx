import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

const SESSION_ENDED_TEXT = /Your Studio session ended/;

// AUTH deviation from the brief: on a missing token at startup, or a 401 from any /api call, Studio shows a
// full-page message instead of the tabs (no retry loop).
describe('App session guard', () => {
  it('shows a full-page message when sessionStorage has no session token at startup', async () => {
    sessionStorage.clear();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByText(SESSION_ENDED_TEXT)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the same full-page message after a 401 from the Home tab fetch', async () => {
    sessionStorage.setItem('coco_studio_session', 'stale-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'no_token' }), { status: 401 })));

    render(<App />);

    expect(await screen.findByText(SESSION_ENDED_TEXT)).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Studio' })).toBeNull();
  });
});
