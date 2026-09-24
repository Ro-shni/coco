import type { ContextMsg } from '../protocol.js';

const VISUAL_HINTS = /(grafana|kibana|dashboard|datadog|superset|looker|metabase|prometheus|figma|chart)/i;
const VISUAL_BUNDLES = new Set(['com.apple.Preview', 'com.figma.Desktop', 'com.apple.Photos']);
const THIN_TEXT_CHARS = 200;

export function isVisuallyHeavy(msg: ContextMsg): boolean {
  if (msg.private) return false;
  if (VISUAL_BUNDLES.has(msg.bundleId)) return true;
  if (VISUAL_HINTS.test(`${msg.windowTitle} ${msg.url ?? ''}`)) return true;
  return (msg.ocrText?.length ?? 0) + (msg.selection?.length ?? 0) < THIN_TEXT_CHARS;
}

export class LookPolicy {
  private recent: readonly number[] = [];
  private lastByKey: ReadonlyMap<string, number> = new Map();

  constructor(
    private readonly dwellMs: number,
    private readonly maxPerMinute: number,
    private readonly relookMs = 120_000,
  ) {}

  shouldLook(msg: ContextMsg, key: string, dwellMs: number, now: number): boolean {
    if (!isVisuallyHeavy(msg) || dwellMs < this.dwellMs) return false;
    if (this.recent.filter((t) => now - t < 60_000).length >= this.maxPerMinute) return false;
    const last = this.lastByKey.get(key);
    return last === undefined || now - last >= this.relookMs;
  }

  record(key: string, now: number): void {
    this.recent = [...this.recent.filter((t) => now - t < 60_000), now];
    this.lastByKey = new Map(this.lastByKey).set(key, now);
  }
}
