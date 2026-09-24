import { describe, expect, it } from 'vitest';
import { LookPolicy, isVisuallyHeavy } from '../../src/context/look.js';
import { T0, ctx } from '../helpers/messages.js';

describe('isVisuallyHeavy', () => {
  it('is true for dashboards by title or url', () => {
    expect(isVisuallyHeavy(ctx())).toBe(true);
  });
  it('is true when there is little text', () => {
    expect(isVisuallyHeavy(ctx({ windowTitle: 'Untitled', url: undefined, ocrText: 'hi' }))).toBe(true);
  });
  it('is false for text-heavy pages', () => {
    expect(isVisuallyHeavy(ctx({ windowTitle: 'Runbook', url: 'https://wiki/x', ocrText: 'word '.repeat(100) }))).toBe(false);
  });
  it('is never true for private contexts', () => {
    expect(isVisuallyHeavy(ctx({ private: true }))).toBe(false);
  });
});

describe('LookPolicy', () => {
  const msg = ctx();
  it('requires the dwell time', () => {
    const p = new LookPolicy(5000, 3);
    expect(p.shouldLook(msg, 'k', 4999, T0)).toBe(false);
    expect(p.shouldLook(msg, 'k', 5000, T0)).toBe(true);
  });
  it('does not re-look the same key within relookMs', () => {
    const p = new LookPolicy(5000, 3, 120_000);
    p.record('k', T0);
    expect(p.shouldLook(msg, 'k', 9000, T0 + 60_000)).toBe(false);
    expect(p.shouldLook(msg, 'k', 9000, T0 + 120_000)).toBe(true);
  });
  it('enforces the per-minute budget across keys', () => {
    const p = new LookPolicy(5000, 3);
    p.record('a', T0);
    p.record('b', T0 + 1000);
    p.record('c', T0 + 2000);
    expect(p.shouldLook(msg, 'd', 9000, T0 + 3000)).toBe(false);
    expect(p.shouldLook(msg, 'd', 9000, T0 + 61_000)).toBe(true);
  });
  it('never looks at text-heavy content', () => {
    const p = new LookPolicy(5000, 3);
    expect(p.shouldLook(ctx({ windowTitle: 'Runbook', url: undefined, ocrText: 'x'.repeat(500) }), 'k', 9000, T0)).toBe(false);
  });
});
