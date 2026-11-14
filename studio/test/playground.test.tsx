import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Playground } from '../src/tabs/Playground';
import { mockFetch } from './helpers';

describe('Playground', () => {
  it('shows an empty state with example prompts and the read-only note', () => {
    mockFetch({});
    render(<Playground />);
    expect(screen.getByText('Read-only tools really run; anything that asks first is only shown.')).toBeTruthy();
    expect(screen.getAllByRole('button').filter((b) => b.className.includes('chip'))).toHaveLength(3);
  });

  it('renders offered tools, each run and the pending ask-first step', async () => {
    const calls = mockFetch({
      'POST /api/playground/ask': () => ({
        offered: ['atlassian__search', 'coco__shell_run'],
        runs: [{ tool: 'atlassian__search', args: { query: 'Wordle' }, ok: true, text: 'found 2 pages', ms: 120, decision: 'auto' }],
        pending: { tool: 'coco__shell_run', args: { command: 'kill 12' }, reason: 'Needs your approval' },
      }),
    });
    render(<Playground />);
    await userEvent.type(screen.getByLabelText('Ask Coco'), 'Search Confluence for Wordle');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('found 2 pages')).toBeTruthy();
    expect(calls.find((c) => c.key === 'POST /api/playground/ask')?.body).toEqual({ question: 'Search Confluence for Wordle' });
    expect(screen.getByText('Tools offered')).toBeTruthy();
    expect(screen.getByText('120 ms')).toBeTruthy();
    expect(screen.getByText('Wordle')).toBeTruthy();
    expect(screen.getByText('Would ask first')).toBeTruthy();
    expect(screen.getByText('Needs your approval')).toBeTruthy();
  });

  it('an example prompt runs immediately; failures show a banner', async () => {
    mockFetch({});
    render(<Playground />);
    await userEvent.click(screen.getByRole('button', { name: 'Search Confluence for Wordle' }));
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't run that");
  });
});
