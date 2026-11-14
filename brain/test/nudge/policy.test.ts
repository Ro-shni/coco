import { describe, expect, it } from 'vitest';
import { MUTE_MS, NudgePolicy, nextLocalMidnight } from '../../src/nudge/policy.js';
import { T0 } from '../helpers/messages.js';

const GAP = 180_000;
const make = () => new NudgePolicy({ minGapMs: GAP });

describe('NudgePolicy.canSpeak', () => {
  it('allows the first nudge while reading', () => {
    expect(make().canSpeak(T0, 'reading')).toEqual({ ok: true });
  });

  it.each(['typing', 'in_call', 'sharing'] as const)('blocks while %s, even for triggers', (a) => {
    expect(make().canSpeak(T0, a, { trigger: true })).toEqual({ ok: false, reason: 'busy' });
  });

  it('enforces the minimum gap for ticks but not for triggers', () => {
    const p = make();
    p.recordSpoke(T0, 'suggestion');
    expect(p.canSpeak(T0 + GAP - 1, 'reading')).toEqual({ ok: false, reason: 'cooldown' });
    expect(p.canSpeak(T0 + GAP - 1, 'reading', { trigger: true })).toEqual({ ok: true });
    expect(p.canSpeak(T0 + GAP, 'reading')).toEqual({ ok: true });
  });

  it('blocks everything while muted, then allows again', () => {
    const p = make();
    p.mute(T0, MUTE_MS);
    expect(p.canSpeak(T0 + MUTE_MS - 1, 'reading', { trigger: true })).toEqual({ ok: false, reason: 'muted' });
    expect(p.isMuted(T0 + MUTE_MS - 1)).toBe(true);
    expect(p.canSpeak(T0 + MUTE_MS, 'reading')).toEqual({ ok: true });
  });
});

describe('back-off', () => {
  it('doubles the gap every two consecutive ignores, capped at 8x', () => {
    const p = make();
    expect(p.currentGapMs()).toBe(GAP);
    p.recordOutcome(false);
    expect(p.currentGapMs()).toBe(GAP);
    p.recordOutcome(false);
    expect(p.currentGapMs()).toBe(GAP * 2);
    for (let i = 0; i < 10; i++) p.recordOutcome(false);
    expect(p.currentGapMs()).toBe(GAP * 8);
  });

  it('resets on engagement', () => {
    const p = make();
    p.recordOutcome(false);
    p.recordOutcome(false);
    p.recordOutcome(true);
    expect(p.currentGapMs()).toBe(GAP);
  });
});

describe('quip cap (~25%)', () => {
  it('allows a quip first, then needs about three non-quips before the next', () => {
    const p = make();
    expect(p.allowQuip()).toBe(true);
    p.recordSpoke(T0, 'quip');
    expect(p.allowQuip()).toBe(false);
    p.recordSpoke(T0, 'suggestion');
    p.recordSpoke(T0, 'suggestion');
    expect(p.allowQuip()).toBe(false);
    p.recordSpoke(T0, 'question');
    expect(p.allowQuip()).toBe(true);
  });
});

describe('state', () => {
  it('snapshot returns a copy and restores via constructor', () => {
    const p = make();
    p.recordSpoke(T0, 'quip');
    const snap = p.snapshot();
    snap.quipCount = 99;
    expect(p.snapshot().quipCount).toBe(1);
    const restored = new NudgePolicy({ minGapMs: GAP }, p.snapshot());
    expect(restored.snapshot()).toEqual(p.snapshot());
  });

  it('muteUntil sets an absolute time', () => {
    const p = make();
    p.muteUntil(T0 + 5);
    expect(p.isMuted(T0 + 4)).toBe(true);
    expect(p.isMuted(T0 + 5)).toBe(false);
  });
});

describe('nextLocalMidnight', () => {
  it('returns the next local midnight after now', () => {
    const now = new Date(2026, 8, 24, 15, 30).getTime();
    expect(nextLocalMidnight(now)).toBe(new Date(2026, 8, 25, 0, 0).getTime());
  });
});
