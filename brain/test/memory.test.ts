import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Memory } from '../src/memory.js';

describe('Memory', () => {
  it('stores turns and returns the most recent n in chronological order', () => {
    const m = new Memory(':memory:');
    for (let i = 0; i < 5; i++) m.addTurn(i % 2 === 0 ? 'user' : 'assistant', `t${i}`, i);
    expect(m.recentTurns(3)).toEqual([
      { role: 'user', text: 't2', ts: 2 },
      { role: 'assistant', text: 't3', ts: 3 },
      { role: 'user', text: 't4', ts: 4 },
    ]);
  });

  it('stores JSON state by key and overwrites', () => {
    const m = new Memory(':memory:');
    expect(m.getState('mutedUntil')).toBeUndefined();
    m.setState('mutedUntil', 123);
    m.setState('mutedUntil', 456);
    expect(m.getState<number>('mutedUntil')).toBe(456);
  });

  it('logs nudges and records outcomes', () => {
    const m = new Memory(':memory:');
    m.logNudge({ id: 'n1', ts: 1, kind: 'suggestion', text: 'hi' });
    expect(m.nudgeOutcome('n1')).toBeNull();
    m.setNudgeOutcome('n1', 'ignored');
    expect(m.nudgeOutcome('n1')).toBe('ignored');
    expect(m.nudgeOutcome('missing')).toBeUndefined();
  });

  it('dedupes facts (re-adding refreshes recency) and returns newest first', () => {
    const m = new Memory(':memory:');
    m.addFact('prefers kubectl', 1);
    m.addFact('on call this week', 2);
    m.addFact('prefers kubectl', 3);
    expect(m.facts()).toEqual(['prefers kubectl', 'on call this week']);
  });

  it('clears all turns, leaving other tables untouched', () => {
    const m = new Memory(':memory:');
    m.addTurn('user', 'hi', 1);
    m.addTurn('assistant', 'hello', 2);
    m.setState('mutedUntil', 123);
    m.clearTurns();
    expect(m.recentTurns(10)).toEqual([]);
    expect(m.getState<number>('mutedUntil')).toBe(123);
  });

  it('persists across instances on disk', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'coco-mem-')), 'coco.db');
    const a = new Memory(path);
    a.setState('mutedUntil', 999);
    a.close();
    const b = new Memory(path);
    expect(b.getState<number>('mutedUntil')).toBe(999);
    b.close();
  });
});
