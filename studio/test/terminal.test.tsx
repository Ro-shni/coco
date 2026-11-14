import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Terminal } from '../src/tabs/Terminal';
import { mockFetch } from './helpers';

describe('Terminal card', () => {
  it('explains the safety model and PUTs the shell mode', async () => {
    const calls = mockFetch({
      'GET /api/builtin': () => ({ tools: [{ qualified: 'coco__shell_run', name: 'shell_run', description: 'Run a shell command', mode: 'auto' }] }),
      'PUT /api/tools/coco__shell_run/mode': () => ({ ok: true }),
    });
    render(<Terminal />);
    expect(screen.getByText(/Read-only commands \(ps, ls, git status…\) run immediately/)).toBeTruthy();
    expect(screen.getByText(/sudo, disk wipes and production hosts are always blocked/)).toBeTruthy();
    const group = await screen.findByRole('radiogroup', { name: 'Permission for shell_run' });
    await userEvent.click(within(group).getByLabelText('Always ask'));
    await waitFor(() => expect(calls.find((c) => c.key === 'PUT /api/tools/coco__shell_run/mode')?.body).toEqual({ mode: 'confirm' }));
  });

  it('shows a banner when the builtin list fails', async () => {
    mockFetch({});
    render(<Terminal />);
    expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load the Terminal");
  });
});
