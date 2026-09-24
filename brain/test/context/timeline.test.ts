import { describe, expect, it } from 'vitest';
import { Timeline, fmtTime } from '../../src/context/timeline.js';
import { T0, ctx } from '../helpers/messages.js';

describe('Timeline', () => {
  it('starts empty', () => {
    const t = new Timeline();
    expect(t.current()).toBeUndefined();
    expect(t.contextKey()).toBeUndefined();
    expect(t.dwellMs(T0)).toBe(0);
    expect(t.render(T0)).toBe('(nothing yet)');
  });

  it('merges consecutive events for the same app+title and keeps the original start as dwell origin', () => {
    const t = new Timeline();
    t.ingest(ctx({ ts: T0 }));
    t.ingest(ctx({ ts: T0 + 4000, ocrText: 'p99 latency 950ms' }));
    expect(t.current()?.since).toBe(T0);
    expect(t.current()?.msg.ocrText).toBe('p99 latency 950ms');
    expect(t.dwellMs(T0 + 6000)).toBe(6000);
    expect(t.render(T0 + 6000).split('\n')).toHaveLength(1);
  });

  it('starts a new entry when the window title changes', () => {
    const t = new Timeline();
    t.ingest(ctx({ ts: T0 }));
    t.ingest(ctx({ ts: T0 + 60_000, app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', windowTitle: '#devops-oncall', url: undefined }));
    expect(t.current()?.since).toBe(T0 + 60_000);
    expect(t.contextKey()).toBe('Slack|#devops-oncall');
    const lines = t.render(T0 + 90_000).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(fmtTime(T0));
    expect(lines[0]).toContain('supply-prd latency - Grafana');
    expect(lines[1]).toContain('#devops-oncall');
  });

  it('hides the title of private entries', () => {
    const t = new Timeline();
    t.ingest(ctx({ app: '1Password', windowTitle: 'Vault', private: true }));
    expect(t.render(T0)).toContain('(private app)');
    expect(t.render(T0)).not.toContain('Vault');
  });

  it('drops entries older than the window', () => {
    const t = new Timeline(10 * 60_000);
    t.ingest(ctx({ ts: T0, windowTitle: 'old' }));
    t.ingest(ctx({ ts: T0 + 11 * 60_000, windowTitle: 'new' }));
    expect(t.render(T0 + 11 * 60_000)).not.toContain('old');
  });

  it('renders at most `max` recent entries', () => {
    const t = new Timeline();
    for (let i = 0; i < 20; i++) t.ingest(ctx({ ts: T0 + i * 1000, windowTitle: `tab ${i}` }));
    const lines = t.render(T0 + 20_000, 5).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[4]).toContain('tab 19');
  });
});
