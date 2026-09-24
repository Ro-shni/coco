import type { ActivityState } from '../protocol.js';

export interface NudgeState {
  lastUnsolicitedAt: number | null;
  mutedUntil: number | null;
  ignoredStreak: number;
  unsolicitedCount: number;
  quipCount: number;
}

export const INITIAL_NUDGE_STATE: NudgeState = Object.freeze({
  lastUnsolicitedAt: null,
  mutedUntil: null,
  ignoredStreak: 0,
  unsolicitedCount: 0,
  quipCount: 0,
});

export type SpeakCheck = { ok: true } | { ok: false; reason: 'muted' | 'busy' | 'cooldown' };
export type UnsolicitedKind = 'quip' | 'suggestion' | 'question';

export const MUTE_MS = 30 * 60_000;
const QUIP_SHARE = 0.25;
const BUSY: ReadonlySet<ActivityState> = new Set(['typing', 'in_call', 'sharing']);

export class NudgePolicy {
  private state: NudgeState;

  constructor(
    private readonly cfg: { minGapMs: number; maxBackoffFactor?: number },
    initial: NudgeState = INITIAL_NUDGE_STATE,
  ) {
    this.state = { ...initial };
  }

  snapshot(): NudgeState {
    return { ...this.state };
  }

  currentGapMs(): number {
    const factor = Math.min(2 ** Math.floor(this.state.ignoredStreak / 2), this.cfg.maxBackoffFactor ?? 8);
    return this.cfg.minGapMs * factor;
  }

  canSpeak(now: number, activity: ActivityState, opts: { trigger?: boolean } = {}): SpeakCheck {
    if (this.isMuted(now)) return { ok: false, reason: 'muted' };
    if (BUSY.has(activity)) return { ok: false, reason: 'busy' };
    const last = this.state.lastUnsolicitedAt;
    if (!opts.trigger && last !== null && now - last < this.currentGapMs()) return { ok: false, reason: 'cooldown' };
    return { ok: true };
  }

  allowQuip(): boolean {
    return this.state.quipCount < QUIP_SHARE * (this.state.unsolicitedCount + 1);
  }

  recordSpoke(now: number, kind: UnsolicitedKind): void {
    this.state = {
      ...this.state,
      lastUnsolicitedAt: now,
      unsolicitedCount: this.state.unsolicitedCount + 1,
      quipCount: this.state.quipCount + (kind === 'quip' ? 1 : 0),
    };
  }

  recordOutcome(engaged: boolean): void {
    this.state = { ...this.state, ignoredStreak: engaged ? 0 : this.state.ignoredStreak + 1 };
  }

  mute(now: number, durationMs: number): void {
    this.muteUntil(now + durationMs);
  }

  muteUntil(ts: number): void {
    this.state = { ...this.state, mutedUntil: ts };
  }

  isMuted(now: number): boolean {
    return this.state.mutedUntil !== null && now < this.state.mutedUntil;
  }
}

export function nextLocalMidnight(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
}
