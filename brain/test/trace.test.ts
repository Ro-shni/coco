import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecisionTrace, createFileTrace, noopTrace } from '../src/trace.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'coco-trace-'));

function setup(overrides: { clock?: () => number; newId?: () => string } = {}) {
  const logsDir = tmp();
  let now = 1000;
  let ids = 0;
  const trace = createFileTrace({
    logsDir,
    clock: overrides.clock ?? (() => now),
    newId: overrides.newId ?? (() => `t${++ids}`),
  });
  const path = join(logsDir, 'trace.jsonl');
  const lines = (): unknown[] =>
    existsSync(path)
      ? readFileSync(path, 'utf8')
          .split('\n')
          .filter((l) => l !== '')
          .map((l) => JSON.parse(l))
      : [];
  return { trace, logsDir, path, lines, advance: (ms: number) => (now += ms) };
}

describe('createDecisionTrace', () => {
  it('returns the shared noop instance when disabled — every call is a no-op, no directory is created', () => {
    const logsDir = join(tmpdir(), 'coco-trace-never-created-1234');
    const trace = createDecisionTrace(false, { logsDir, clock: () => 1, newId: () => 'x' });
    expect(trace).toBe(noopTrace);
    const turnId = trace.startTurn({ source: 'voice', text: 'open slack' });
    expect(turnId).toBe('');
    trace.setRoute(turnId, { via: 'command' });
    trace.finishTurn(turnId);
    expect(existsSync(logsDir)).toBe(false);
  });

  it('returns a file-backed trace when enabled', () => {
    const logsDir = tmp();
    const trace = createDecisionTrace(true, { logsDir, clock: () => 1, newId: () => 'x' });
    expect(trace).not.toBe(noopTrace);
  });
});

describe('DecisionTrace (file-backed)', () => {
  it('writes one JSON line per turn, with a shared turnId, once finished', () => {
    const s = setup();
    const turnId = s.trace.startTurn({ source: 'voice', text: 'open slack' });
    expect(turnId).toBe('t1');
    s.trace.setRoute(turnId, { via: 'command', command: { type: 'focus', target: 'slack', kind: 'app' } });
    s.trace.addSent(turnId, { type: 'focus', payload: { target: 'slack', kind: 'app' } });
    s.advance(50);
    s.trace.addResult(turnId, { type: 'focus_result', ok: true, matched: 'Slack', ms: 50 });
    s.trace.finishTurn(turnId);

    const lines = s.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      turnId: 't1',
      utterance: { source: 'voice', text: 'open slack' },
      route: { via: 'command', command: { type: 'focus', target: 'slack', kind: 'app' } },
      sent: [{ type: 'focus', payload: { target: 'slack', kind: 'app' } }],
      result: { type: 'focus_result', ok: true, matched: 'Slack', ms: 50 },
    });
    expect(lines[0]).toHaveProperty('ts');
  });

  it('omits fields that were never set (no route/model_call/extracted/gate/sent/result keys at all)', () => {
    const s = setup();
    const turnId = s.trace.startTurn({ source: 'chat', text: 'hi' });
    s.trace.finishTurn(turnId);
    const [line] = s.lines() as Record<string, unknown>[];
    expect(Object.keys(line!).sort()).toEqual(['ts', 'turnId', 'utterance'].sort());
  });

  it('collects multiple model_call entries and the final extracted/gate for a model-routed turn', () => {
    const s = setup();
    const turnId = s.trace.startTurn({ source: 'chat', text: 'open notion in chrome' });
    s.trace.setRoute(turnId, { via: 'model' });
    s.trace.addModelCall(turnId, { n: 1, purpose: 'reply', ms: 120, rawReply: 'Opening it now.' });
    s.trace.addModelCall(turnId, { n: 2, purpose: 'honesty_rewrite', ms: 80, rawReply: "I won't open that unless you ask me to." });
    s.trace.setGate(turnId, { allowed: false, reason: 'no intentText for this turn' });
    s.trace.setExtracted(turnId, { text: "I won't open that unless you ask me to.", actionBlockPresent: true });
    s.trace.addSent(turnId, { type: 'say', payload: { text: "I won't open that unless you ask me to." } });
    s.trace.finishTurn(turnId);

    const [line] = s.lines() as Record<string, unknown>[];
    expect(line!.model_call).toEqual([
      { n: 1, purpose: 'reply', ms: 120, rawReply: 'Opening it now.' },
      { n: 2, purpose: 'honesty_rewrite', ms: 80, rawReply: "I won't open that unless you ask me to." },
    ]);
    expect(line!.gate).toEqual({ allowed: false, reason: 'no intentText for this turn' });
    expect(line!.extracted).toEqual({ text: "I won't open that unless you ask me to.", actionBlockPresent: true });
  });

  it('every setter is a safe no-op for an unknown turnId (never started, or already finished)', () => {
    const s = setup();
    expect(() => {
      s.trace.setRoute('nope', { via: 'command' });
      s.trace.addModelCall('nope', { n: 1, purpose: 'reply', ms: 1, rawReply: 'x' });
      s.trace.setExtracted('nope', { text: 'x', actionBlockPresent: false });
      s.trace.setGate('nope', { allowed: true, reason: 'ok' });
      s.trace.addSent('nope', { type: 'say', payload: {} });
      s.trace.addResult('nope', { type: 'focus_result', ok: true, ms: 1 });
      s.trace.finishTurn('nope');
      s.trace.finishTurn('');
    }).not.toThrow();
    expect(s.lines()).toHaveLength(0);

    const turnId = s.trace.startTurn({ source: 'voice', text: 'go to slack' });
    s.trace.finishTurn(turnId);
    s.trace.setRoute(turnId, { via: 'command' }); // already finished — no-op, no second line
    s.trace.finishTurn(turnId);
    expect(s.lines()).toHaveLength(1);
  });

  it('rotates the file to .1 once it reaches 5MB, keeping exactly one rotated generation', () => {
    const s = setup();
    writeFileSync(s.path, `${'x'.repeat(5 * 1024 * 1024)}\n`);
    const before = readFileSync(s.path, 'utf8');

    const turnId = s.trace.startTurn({ source: 'voice', text: 'open slack' });
    s.trace.finishTurn(turnId);

    expect(existsSync(`${s.path}.1`)).toBe(true);
    expect(readFileSync(`${s.path}.1`, 'utf8')).toBe(before);
    expect(s.lines()).toHaveLength(1); // the fresh file holds only the new line

    // A second rotation overwrites the previous .1 rather than accumulating .2, .3, ...
    writeFileSync(s.path, `${'y'.repeat(5 * 1024 * 1024)}\n`);
    const secondBefore = readFileSync(s.path, 'utf8');
    const turnId2 = s.trace.startTurn({ source: 'voice', text: 'open code' });
    s.trace.finishTurn(turnId2);
    expect(readFileSync(`${s.path}.1`, 'utf8')).toBe(secondBefore);
    expect(existsSync(`${s.path}.2`)).toBe(false);
  });

  it('does not rotate below the size floor', () => {
    const s = setup();
    writeFileSync(s.path, '{"pre-existing":true}\n');
    const turnId = s.trace.startTurn({ source: 'voice', text: 'open slack' });
    s.trace.finishTurn(turnId);
    expect(existsSync(`${s.path}.1`)).toBe(false);
    expect(s.lines()).toHaveLength(2);
  });

  it('logNudgeDecision writes an immediate, standalone line (no turnId) with model calls and problems', () => {
    const s = setup();
    s.trace.logNudgeDecision({
      modelCalls: [{ n: 1, purpose: 'nudge', ms: 200, rawReply: '{"speak":false}' }],
      decision: null,
      selfcheckProblems: [],
    });
    const [line] = s.lines() as Record<string, unknown>[];
    expect(line).toMatchObject({
      type: 'nudge_decision',
      modelCalls: [{ n: 1, purpose: 'nudge', ms: 200, rawReply: '{"speak":false}' }],
      decision: null,
      selfcheckProblems: [],
    });
    expect(line).toHaveProperty('ts');
  });

  it('sweep force-flushes a turn that has sat unfinished past the staleness window, with whatever was collected', () => {
    const s = setup();
    const turnId = s.trace.startTurn({ source: 'voice', text: 'open slack' });
    s.trace.setRoute(turnId, { via: 'command', command: { type: 'focus', target: 'slack', kind: 'app' } });
    s.trace.addSent(turnId, { type: 'focus', payload: { target: 'slack', kind: 'app' } });

    s.advance(4 * 60_000);
    s.trace.sweep(1000 + 4 * 60_000); // not stale yet (< 5 minutes)
    expect(s.lines()).toHaveLength(0);

    s.advance(2 * 60_000);
    s.trace.sweep(1000 + 6 * 60_000); // now stale
    const lines = s.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ turnId, sent: [{ type: 'focus', payload: { target: 'slack', kind: 'app' } }] });
    expect(lines[0]).not.toHaveProperty('result');

    // Already flushed by sweep — a later finishTurn is a no-op, not a duplicate line.
    s.trace.finishTurn(turnId);
    expect(s.lines()).toHaveLength(1);
  });

  it('sweep never flushes turns still within the staleness window', () => {
    const s = setup();
    const turnId = s.trace.startTurn({ source: 'voice', text: 'open slack' });
    s.trace.sweep(1000 + 1000);
    expect(s.lines()).toHaveLength(0);
    s.trace.finishTurn(turnId); // cleanup so the turn isn't left dangling for the test itself
    expect(s.lines()).toHaveLength(1);
  });
});

describe('createDecisionTrace logs dir', () => {
  it('returns the no-op trace when debug.trace is off, writing nothing', () => {
    const logsDir = join(mkdtempSync(join(tmpdir(), 'coco-trace-off-')), 'logs');
    const t = createDecisionTrace(false, { logsDir, clock: () => 0, newId: () => 'x' });
    expect(t).toBe(noopTrace);
    expect(t.startTurn({ source: 'chat', text: 'hi' })).toBe('');
    expect(existsSync(logsDir)).toBe(false);
  });

  it('creates the logs dir and returns a file trace when debug.trace is on', () => {
    const logsDir = join(mkdtempSync(join(tmpdir(), 'coco-trace-on-')), 'logs');
    const t = createDecisionTrace(true, { logsDir, clock: () => 0, newId: () => 'turn1' });
    expect(t).not.toBe(noopTrace);
    expect(existsSync(logsDir)).toBe(true);
    const id = t.startTurn({ source: 'chat', text: 'hi' });
    t.finishTurn(id);
    expect(readFileSync(join(logsDir, 'trace.jsonl'), 'utf8')).toContain('"turnId":"turn1"');
  });
});
