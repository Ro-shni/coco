import { describe, expect, it } from 'vitest';
import { extractJson, parseDecision } from '../../src/persona/decision.js';

const good = { speak: true, kind: 'suggestion', text: 'p99 jumped at 10:40.', chips: ['check deploys'], pointAt: '10:40' };

// Verbatim reply qwen3.5:9b produced on 2026-09-24 when the schema was only passed via `format`.
const OBSERVED_WRONG_SHAPE = JSON.stringify({
  decision: 'speak',
  reasoning: 'That is a massive spike!',
  action: 'alert_matey',
  message: "Zephyr, wake up! The charts are screaming! That's like a sloth on espresso!",
});

describe('extractJson', () => {
  it('parses plain JSON', () => {
    expect(extractJson(JSON.stringify(good))).toEqual(good);
  });
  it('parses JSON inside a ```json fence', () => {
    expect(extractJson('```json\n' + JSON.stringify(good) + '\n```')).toEqual(good);
  });
  it('parses JSON surrounded by prose', () => {
    expect(extractJson('Sure! Here it is: ' + JSON.stringify(good) + ' Hope that helps.')).toEqual(good);
  });
  it('returns undefined for non-JSON', () => {
    expect(extractJson('I think you should check the deploy.')).toBeUndefined();
  });
});

describe('parseDecision', () => {
  it('accepts a valid decision', () => {
    expect(parseDecision(JSON.stringify(good))).toEqual({ ok: true, decision: good });
  });
  it('accepts pointAt null and empty chips', () => {
    const d = { ...good, chips: [], pointAt: null };
    expect(parseDecision(JSON.stringify(d))).toEqual({ ok: true, decision: d });
  });
  it('rejects the observed wrong-shape reply with a message naming the missing keys', () => {
    const r = parseDecision(OBSERVED_WRONG_SHAPE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/wrong shape/);
      expect(r.error).toMatch(/speak/);
      expect(r.error).toMatch(/text/);
    }
  });
  it('rejects non-JSON with a clear error', () => {
    expect(parseDecision('nope')).toEqual({ ok: false, error: 'reply was not JSON' });
  });
  it('rejects more than 3 chips', () => {
    expect(parseDecision(JSON.stringify({ ...good, chips: ['a', 'b', 'c', 'd'] })).ok).toBe(false);
  });
});
