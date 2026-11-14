import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Activity } from '../src/tabs/Activity';

describe('Activity tab', () => {
  it('lists audit rows newest first with decision badges', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { id: 2, ts: 1790000000000, serverId: 'atlassian', tool: 'createJiraIssue', decision: 'denied', ok: null, ms: null, resultChars: null },
      { id: 1, ts: 1789999990000, serverId: 'atlassian', tool: 'getJiraIssue', decision: 'auto', ok: true, ms: 120, resultChars: 900 },
    ]))));
    render(<Activity />);
    // `findAllByRole` resolves as soon as ANY row exists (the static header row), so it can't be used to wait
    // for the 2 data rows to land — wait for the actual count via `waitFor` instead (fix: brief's given test
    // raced the header row; see deviations in the report).
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3)); // header + 2
    const rows = screen.getAllByRole('row');
    expect(rows[1]!.textContent).toContain('createJiraIssue');
    expect(rows[1]!.textContent).toContain('denied');
    expect(rows[2]!.textContent).toContain('120 ms');
  });
});

describe('Activity filters and empty state', () => {
  const rows = [
    { id: 2, ts: Date.now() - 2 * 60_000, serverId: 'atlassian', tool: 'createJiraIssue', decision: 'denied', ok: null, ms: null, resultChars: null },
    { id: 1, ts: Date.now() - 3 * 3600_000, serverId: 'slack', tool: 'post', decision: 'auto', ok: true, ms: 120, resultChars: 900 },
  ];
  it('shows relative times and filters by connector', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(rows))));
    render(<Activity />);
    expect(await screen.findByText('2 min ago')).toBeTruthy();
    expect(screen.getByText('3 hours ago')).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Filter by connector'), 'slack');
    expect(screen.queryByText('createJiraIssue')).toBeNull();
    expect(screen.getByText('post')).toBeTruthy();
  });
  it('shows an empty state with no rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]))));
    render(<Activity />);
    expect(await screen.findByText('Nothing has run yet')).toBeTruthy();
  });
});
