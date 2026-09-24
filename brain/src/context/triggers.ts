import type { ContextMsg } from '../protocol.js';

export type TriggerKind = 'error_dialog' | 'build_failed' | 'slack_mention' | 'alert_page';

export interface Trigger {
  kind: TriggerKind;
  detail: string;
}

const TERMINALS = new Set([
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'com.mitchellh.ghostty',
  'net.kovidgoyal.kitty',
  'com.github.wez.wezterm',
]);
const SLACK = 'com.tinyspeck.slackmacgap';
const ERROR_TITLE = /\b(error|failed|failure|exception|crash(ed)?|fatal)\b/i;
const BUILD_FAIL = /(BUILD FAILED|npm ERR!|error\[E\d+\]|Traceback \(most recent call last\)|--- FAIL:|FAIL\s+\S+|panic:|Exception in thread)/;
const ALERT_URL = /(pagerduty\.com\/incidents|alertmanager|\/alerting\/list|opsgenie\.com\/alert)/i;

export function detectTrigger(msg: ContextMsg, handles: readonly string[]): Trigger | null {
  if (msg.private) return null;
  const text = `${msg.selection ?? ''}\n${msg.ocrText ?? ''}`;
  if (ALERT_URL.test(msg.url ?? '') || /\bFIRING\b/.test(msg.windowTitle)) {
    return { kind: 'alert_page', detail: msg.windowTitle.slice(0, 120) };
  }
  const isTerminal = TERMINALS.has(msg.bundleId);
  if (isTerminal) {
    const match = text.match(BUILD_FAIL);
    if (match) return { kind: 'build_failed', detail: match[0] };
  }
  if (msg.bundleId === SLACK) {
    const lower = text.toLowerCase();
    for (const handle of handles) {
      const at = `@${handle.replace(/^@/, '').toLowerCase()}`;
      if (lower.includes(at)) return { kind: 'slack_mention', detail: at };
    }
  }
  if (!isTerminal && ERROR_TITLE.test(msg.windowTitle)) {
    return { kind: 'error_dialog', detail: msg.windowTitle.slice(0, 120) };
  }
  return null;
}

export class TriggerDeduper {
  private seen: ReadonlyMap<string, number> = new Map();

  constructor(private readonly windowMs = 10 * 60_000) {}

  isNew(t: Trigger, now: number): boolean {
    const last = this.seen.get(`${t.kind}:${t.detail}`);
    return last === undefined || now - last >= this.windowMs;
  }

  mark(t: Trigger, now: number): void {
    this.seen = new Map(this.seen).set(`${t.kind}:${t.detail}`, now);
  }
}
