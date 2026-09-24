import { describe, expect, it } from 'vitest';
import { TriggerDeduper, detectTrigger } from '../../src/context/triggers.js';
import { T0, ctx } from '../helpers/messages.js';

const terminal = (ocrText: string) =>
  ctx({ app: 'Ghostty', bundleId: 'com.mitchellh.ghostty', windowTitle: 'zsh', url: undefined, ocrText });

describe('detectTrigger', () => {
  it('detects alert pages by url', () => {
    expect(detectTrigger(ctx({ url: 'https://x.pagerduty.com/incidents/Q1' }), [])?.kind).toBe('alert_page');
  });
  it('detects alert pages by FIRING title', () => {
    expect(detectTrigger(ctx({ windowTitle: '[FIRING:2] HighLatency' }), [])?.kind).toBe('alert_page');
  });
  it.each(['BUILD FAILED in 3s', 'npm ERR! code 1', 'Traceback (most recent call last):', '--- FAIL: TestX', 'panic: nil map'])(
    'detects build failures in terminals: %s',
    (text) => {
      expect(detectTrigger(terminal(text), [])?.kind).toBe('build_failed');
    },
  );
  it('does not treat terminal window titles as error dialogs', () => {
    expect(detectTrigger(ctx({ bundleId: 'com.mitchellh.ghostty', windowTitle: 'error.log', ocrText: 'fine' }), [])).toBeNull();
  });
  it('detects slack mentions of the configured handles, case-insensitively, with or without @', () => {
    const slack = ctx({ app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', windowTitle: '#devops', url: undefined, ocrText: 'hey @Roshni can you check the canary' });
    expect(detectTrigger(slack, ['roshni'])).toEqual({ kind: 'slack_mention', detail: '@roshni' });
    expect(detectTrigger(slack, ['@roshni'])?.kind).toBe('slack_mention');
    expect(detectTrigger(slack, ['someoneelse'])).toBeNull();
  });
  it('detects error dialogs by window title outside terminals', () => {
    expect(detectTrigger(ctx({ app: 'Docker', bundleId: 'com.docker.docker', windowTitle: 'Docker Desktop - Fatal error', url: undefined }), [])?.kind).toBe('error_dialog');
  });
  it('never fires on private contexts', () => {
    expect(detectTrigger(ctx({ windowTitle: '[FIRING:1] X', private: true }), [])).toBeNull();
  });
  it('returns null for ordinary screens', () => {
    expect(detectTrigger(ctx(), ['roshni'])).toBeNull();
  });
});

describe('TriggerDeduper', () => {
  const t = { kind: 'build_failed' as const, detail: 'npm ERR!' };
  it('treats an unseen trigger as new until marked, then suppresses it for the window', () => {
    const d = new TriggerDeduper(10 * 60_000);
    expect(d.isNew(t, T0)).toBe(true);
    expect(d.isNew(t, T0)).toBe(true);
    d.mark(t, T0);
    expect(d.isNew(t, T0 + 60_000)).toBe(false);
    expect(d.isNew(t, T0 + 10 * 60_000)).toBe(true);
  });
});
