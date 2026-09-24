import type { ContextMsg } from '../protocol.js';

interface TimelineEntry {
  start: number;
  end: number;
  app: string;
  title: string;
  url?: string;
  private: boolean;
}

export interface CurrentContext {
  msg: ContextMsg;
  since: number;
}

export const fmtTime = (ts: number): string => new Date(ts).toTimeString().slice(0, 5);

const fmtDuration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
};

export class Timeline {
  private entries: readonly TimelineEntry[] = [];
  private cur: CurrentContext | undefined;

  constructor(private readonly windowMs = 30 * 60_000) {}

  ingest(msg: ContextMsg): void {
    const last = this.entries.at(-1);
    const same = last !== undefined && last.app === msg.app && last.title === msg.windowTitle && last.private === msg.private;
    if (same) {
      this.entries = [...this.entries.slice(0, -1), { ...last, end: msg.ts, url: msg.url ?? last.url }];
      this.cur = { msg, since: last.start };
    } else {
      const entry: TimelineEntry = { start: msg.ts, end: msg.ts, app: msg.app, title: msg.windowTitle, url: msg.url, private: msg.private };
      this.entries = [...this.entries, entry];
      this.cur = { msg, since: msg.ts };
    }
    this.entries = this.entries.filter((e) => e.end >= msg.ts - this.windowMs);
  }

  current(): CurrentContext | undefined {
    return this.cur;
  }

  dwellMs(now: number): number {
    return this.cur ? now - this.cur.since : 0;
  }

  contextKey(): string | undefined {
    return this.cur ? `${this.cur.msg.app}|${this.cur.msg.windowTitle}` : undefined;
  }

  render(now: number, max = 12): string {
    if (this.entries.length === 0) return '(nothing yet)';
    return this.entries
      .slice(-max)
      .map((e, i, arr) => {
        const end = i === arr.length - 1 ? now : e.end;
        const what = e.private ? '(private app)' : `${e.app} — ${e.title}${e.url ? ` <${e.url}>` : ''}`;
        return `${fmtTime(e.start)} ${what} (${fmtDuration(end - e.start)})`;
      })
      .join('\n');
  }
}
