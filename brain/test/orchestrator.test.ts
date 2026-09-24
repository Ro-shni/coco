import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { LookPolicy } from '../src/context/look.js';
import { Timeline } from '../src/context/timeline.js';
import { TriggerDeduper } from '../src/context/triggers.js';
import { silentLogger } from '../src/logger.js';
import { Memory } from '../src/memory.js';
import { ModelUnavailableError, PRIORITY } from '../src/model/gateway.js';
import { NudgePolicy } from '../src/nudge/policy.js';
import { Orchestrator, type OrchestratorDeps } from '../src/orchestrator.js';
import type { NudgeDecision } from '../src/persona/decision.js';
import type { ActivityState, BrainToBody, SayMsg } from '../src/protocol.js';
import { T0, ctx } from './helpers/messages.js';

const decision: NudgeDecision = { speak: true, kind: 'suggestion', text: 'p99 jumped at 10:40. Check the 10:38 deploy?', chips: ['check deploys'], pointAt: '10:40' };
const act = (state: ActivityState) => ({ v: 1 as const, type: 'activity' as const, state, ts: T0 });
const runbook = ctx({ app: 'Arc', bundleId: 'company.thebrowser.Browser', windowTitle: 'Rollback runbook - Confluence', url: 'https://wiki/rollback', ocrText: 'step '.repeat(100) });
const terminalFail = ctx({ app: 'Ghostty', bundleId: 'com.mitchellh.ghostty', windowTitle: 'zsh', url: undefined, ocrText: 'npm ERR! code 1' });

function setup(overrides: Partial<OrchestratorDeps> = {}, memory = new Memory(':memory:')) {
  let now = T0;
  let ids = 0;
  const sent: BrainToBody[] = [];
  const decide = vi.fn<OrchestratorDeps['decider']['decide']>().mockResolvedValue(decision);
  const reply = vi.fn<OrchestratorDeps['chat']['reply']>().mockResolvedValue('An answer.');
  const health = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const policy = new NudgePolicy({ minGapMs: 180_000 });
  const deps: OrchestratorDeps = {
    send: (m) => sent.push(m),
    clock: () => now,
    newId: () => `n${++ids}`,
    config: { ...DEFAULT_CONFIG, user: { name: 'Roshni', handles: ['roshni'] } },
    timeline: new Timeline(),
    look: new LookPolicy(5000, 3),
    policy,
    triggers: new TriggerDeduper(),
    decider: { decide },
    chat: { reply },
    memory,
    gateway: { health },
    keyframesEnabled: true,
    log: silentLogger,
    ...overrides,
  };
  const o = new Orchestrator(deps);
  return {
    o, sent, decide, reply, health, policy, memory,
    advance: (ms: number) => { now += ms; },
    says: () => sent.filter((m): m is SayMsg => m.type === 'say'),
    moods: () => sent.filter((m) => m.type === 'mood').map((m) => (m as { mood: string }).mood),
  };
}

describe('periodic nudges', () => {
  it('asks the decider on tick and sends a say with a trailing shh chip', async () => {
    const s = setup();
    await s.o.handle(runbook);
    await s.o.tick();
    expect(s.decide).toHaveBeenCalledOnce();
    const [input, priority] = s.decide.mock.calls[0]!;
    expect(priority).toBe(PRIORITY.tick);
    expect(input).toMatchObject({ userName: 'Roshni', activity: 'reading', trigger: null, incidentMode: false, allowQuip: true });
    expect(input.keyframe).toBeUndefined();
    expect(s.says()).toEqual([
      { v: 1, type: 'say', nudgeId: 'n1', text: decision.text, kind: 'suggestion', chips: ['check deploys', 'shh'], speak: false, pointAt: '10:40' },
    ]);
    expect(s.memory.nudgeOutcome('n1')).toBeNull();
  });

  it('does not consult the model while typing, or on private screens, or with no context', async () => {
    const s = setup();
    await s.o.tick();
    await s.o.handle(ctx({ private: true, app: '1Password' }));
    await s.o.tick();
    await s.o.handle(runbook);
    await s.o.handle(act('typing'));
    await s.o.tick();
    expect(s.decide).not.toHaveBeenCalled();
  });

  it('drops the decision if the user got busy while the model was thinking', async () => {
    const s = setup();
    s.decide.mockImplementation(async () => {
      await s.o.handle(act('typing'));
      return decision;
    });
    await s.o.handle(runbook);
    await s.o.tick();
    expect(s.says()).toHaveLength(0);
  });

  it('respects the cooldown between unsolicited nudges', async () => {
    const s = setup();
    await s.o.handle(runbook);
    await s.o.tick();
    s.advance(60_000);
    await s.o.tick();
    expect(s.decide).toHaveBeenCalledOnce();
  });

  it('flags incident mode and a worried mood on incident screens', async () => {
    const s = setup();
    await s.o.handle(ctx({ windowTitle: 'SEV-1 bridge', url: undefined, ocrText: 'step '.repeat(60) }));
    expect(s.moods().at(-1)).toBe('worried');
    await s.o.tick();
    expect(s.decide.mock.calls[0]![0].incidentMode).toBe(true);
  });
});

describe('keyframes', () => {
  it('requests one keyframe after 5s dwell on a visual screen and passes it to the decider', async () => {
    const s = setup();
    await s.o.handle(ctx());
    s.o.pulse();
    expect(s.sent.filter((m) => m.type === 'request_keyframe')).toHaveLength(0);
    s.advance(6000);
    s.o.pulse();
    s.o.pulse();
    expect(s.sent.filter((m) => m.type === 'request_keyframe')).toHaveLength(1);
    await s.o.handle({ v: 1, type: 'keyframe', jpegBase64: 'SlBFRw==', width: 10, height: 10, ts: T0 });
    expect(s.decide.mock.calls[0]![0].keyframe).toBe('SlBFRw==');
  });

  it('never requests keyframes when disabled or while busy', async () => {
    const off = setup({ keyframesEnabled: false });
    await off.o.handle(ctx());
    off.advance(6000);
    off.o.pulse();
    const busy = setup();
    await busy.o.handle(ctx());
    await busy.o.handle(act('in_call'));
    busy.advance(6000);
    busy.o.pulse();
    expect([...off.sent, ...busy.sent].filter((m) => m.type === 'request_keyframe')).toHaveLength(0);
  });
});

describe('strong triggers', () => {
  it('decides immediately with trigger priority, bypassing the cooldown, once per trigger', async () => {
    const s = setup();
    await s.o.handle(runbook);
    await s.o.tick();
    s.advance(10_000);
    await s.o.handle(terminalFail);
    expect(s.decide).toHaveBeenCalledTimes(2);
    const [input, priority] = s.decide.mock.calls[1]!;
    expect(priority).toBe(PRIORITY.trigger);
    expect(input.trigger).toEqual({ kind: 'build_failed', detail: 'npm ERR!' });
    await s.o.handle({ ...terminalFail, ocrText: 'npm ERR! code 1\n$' });
    expect(s.decide).toHaveBeenCalledTimes(2);
  });

  it('does not consume a trigger that arrived while busy', async () => {
    const s = setup();
    await s.o.handle(act('typing'));
    await s.o.handle(terminalFail);
    expect(s.decide).not.toHaveBeenCalled();
    await s.o.handle(act('reading'));
    await s.o.handle({ ...terminalFail, ocrText: 'npm ERR! code 1\n$' });
    expect(s.decide).toHaveBeenCalledOnce();
  });
});

describe('engagement', () => {
  it('marks a nudge ignored after 20s without response and backs off', async () => {
    const s = setup();
    await s.o.handle(runbook);
    await s.o.tick();
    s.advance(20_000);
    s.o.pulse();
    expect(s.memory.nudgeOutcome('n1')).toBe('ignored');
    expect(s.policy.snapshot().ignoredStreak).toBe(1);
  });

  it('a late chip click on an expired nudge still counts as engagement', async () => {
    const s = setup();
    await s.o.handle(runbook);
    await s.o.tick();
    s.advance(25_000);
    s.o.pulse();
    await s.o.handle({ v: 1, type: 'chip', nudgeId: 'n1', choice: 'check deploys' });
    expect(s.memory.nudgeOutcome('n1')).toBe('engaged');
    expect(s.policy.snapshot().ignoredStreak).toBe(0);
  });

  it('answers a chip click through chat, quoting the original nudge', async () => {
    const s = setup();
    await s.o.handle(runbook);
    await s.o.tick();
    await s.o.handle({ v: 1, type: 'chip', nudgeId: 'n1', choice: 'check deploys' });
    expect(s.memory.nudgeOutcome('n1')).toBe('engaged');
    expect(s.reply.mock.calls[0]![0]).toBe(`I clicked "check deploys" on what you said: "${decision.text}"`);
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: 'An answer.', chips: [] });
  });

  it('treats dismiss as ignored', async () => {
    const s = setup();
    await s.o.handle(runbook);
    await s.o.tick();
    await s.o.handle({ v: 1, type: 'chip', nudgeId: 'n1', choice: 'dismiss' });
    expect(s.memory.nudgeOutcome('n1')).toBe('ignored');
    expect(s.reply).not.toHaveBeenCalled();
  });

  it('answers utterances and counts them as engagement with pending nudges', async () => {
    const s = setup();
    await s.o.handle(runbook);
    await s.o.tick();
    await s.o.handle({ v: 1, type: 'utterance', text: 'what is this?', source: 'chat' });
    expect(s.memory.nudgeOutcome('n1')).toBe('engaged');
    const [text, chatCtx] = s.reply.mock.calls[0]!;
    expect(text).toBe('what is this?');
    expect(chatCtx.current?.windowTitle).toBe('Rollback runbook - Confluence');
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: 'An answer.' });
  });
});

describe('muting', () => {
  it('shh chip mutes for 30 minutes, persists, and confirms', async () => {
    const s = setup();
    await s.o.handle(runbook);
    await s.o.tick();
    await s.o.handle({ v: 1, type: 'chip', nudgeId: 'n1', choice: 'shh' });
    expect(s.memory.nudgeOutcome('n1')).toBe('muted');
    expect(s.policy.snapshot().ignoredStreak).toBe(0);
    expect(s.memory.getState<number>('mutedUntil')).toBe(T0 + 30 * 60_000);
    expect(s.says().at(-1)).toMatchObject({ kind: 'status', text: "Muted for 30 minutes. I'll still answer if you ask." });
    s.advance(29 * 60_000);
    await s.o.tick();
    expect(s.decide).toHaveBeenCalledOnce();
  });

  it('"shh for today" typed in chat mutes until midnight; "unmute" lifts it', async () => {
    const s = setup();
    await s.o.handle(runbook);
    await s.o.handle({ v: 1, type: 'utterance', text: 'shh for today', source: 'chat' });
    expect(s.policy.isMuted(T0 + 60_000)).toBe(true);
    expect(s.says().at(-1)!.text).toMatch(/until tomorrow/);
    await s.o.handle({ v: 1, type: 'utterance', text: 'unmute', source: 'chat' });
    expect(s.policy.isMuted(T0 + 60_000)).toBe(false);
    expect(s.reply).not.toHaveBeenCalled();
  });

  it('mute survives a brain restart (same SQLite file)', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'coco-orch-')), 'coco.db');
    const first = setup({}, new Memory(path));
    await first.o.handle(runbook);
    await first.o.handle({ v: 1, type: 'utterance', text: 'shh', source: 'chat' });
    first.memory.close();
    const second = setup({}, new Memory(path));
    await second.o.handle(runbook);
    await second.o.tick();
    expect(second.decide).not.toHaveBeenCalled();
    second.memory.close();
  });
});

describe('model health', () => {
  it('a model error flips to offline once (sleepy + status), and health recovery announces once', async () => {
    const s = setup();
    s.decide.mockRejectedValue(new ModelUnavailableError('down'));
    await s.o.handle(runbook);
    await s.o.tick();
    expect(s.moods().at(-1)).toBe('sleepy');
    expect(s.says().filter((m) => m.kind === 'status').map((m) => m.text)).toEqual(["Brain offline: Ollama isn't answering. I'll keep checking."]);
    s.health.mockResolvedValue(false);
    await s.o.checkHealth();
    s.advance(200_000);
    await s.o.tick();
    expect(s.decide).toHaveBeenCalledOnce();
    s.health.mockResolvedValue(true);
    await s.o.checkHealth();
    await s.o.checkHealth();
    expect(s.says().filter((m) => m.kind === 'status')).toHaveLength(2);
    expect(s.says().at(-1)!.text).toBe("I'm back. Brain's online.");
    expect(s.moods().at(-1)).toBe('curious');
  });

  it('chat while offline gets one clear answer instead of silence', async () => {
    const s = setup();
    s.health.mockResolvedValue(false);
    await s.o.checkHealth();
    s.reply.mockRejectedValue(new ModelUnavailableError('down'));
    await s.o.handle({ v: 1, type: 'utterance', text: 'hello?', source: 'chat' });
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: "My brain's offline right now (Ollama isn't answering). I'll be back when it is." });
  });

  it('re-sends the current mood when the body reconnects', async () => {
    const s = setup();
    await s.o.handle(runbook);
    const before = s.moods().length;
    s.o.onBodyConnected();
    expect(s.moods().length).toBe(before + 1);
  });
});
