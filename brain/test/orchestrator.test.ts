import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { LookPolicy } from '../src/context/look.js';
import { Timeline } from '../src/context/timeline.js';
import { TriggerDeduper } from '../src/context/triggers.js';
import { silentLogger } from '../src/logger.js';
import { Memory } from '../src/memory.js';
import { ModelRequestError, ModelUnavailableError, PRIORITY } from '../src/model/gateway.js';
import { NudgePolicy } from '../src/nudge/policy.js';
import { Orchestrator, type OrchestratorDeps } from '../src/orchestrator.js';
import type { NudgeDecision } from '../src/persona/decision.js';
import { encodeBrainMessage, type ActivityState, type BrainToBody, type PasteMsg, type SayMsg } from '../src/protocol.js';
import { createFileTrace, type DecisionTrace } from '../src/trace.js';
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
  const reply = vi.fn<OrchestratorDeps['chat']['reply']>().mockResolvedValue({ text: 'An answer.', draft: null });
  const health = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const policy = new NudgePolicy({ minGapMs: 180_000 });
  const deps: OrchestratorDeps = {
    // Validates against the protocol schema before recording, like server.ts's real send (via
    // encodeBrainMessage) — so a message that would actually fail to reach the body (M4: e.g. an overlong
    // url) throws here too, exercising the same code path startFocus/startOpenUrl guard against.
    send: (m) => {
      encodeBrainMessage(m);
      sent.push(m);
    },
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
      { v: 1, type: 'say', nudgeId: 'n1', text: decision.text, kind: 'suggestion', chips: ['check deploys', 'shh'], speak: true, pointAt: '10:40' },
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

  it('holds a trigger arriving while busy as pending and retries it on pulse once free, with no new context', async () => {
    const s = setup();
    await s.o.handle(act('typing'));
    await s.o.handle(terminalFail);
    expect(s.decide).not.toHaveBeenCalled();
    await s.o.handle(act('reading'));
    await s.o.pulse();
    expect(s.decide).toHaveBeenCalledOnce();
    const [input, priority] = s.decide.mock.calls[0]!;
    expect(priority).toBe(PRIORITY.trigger);
    expect(input.trigger).toEqual({ kind: 'build_failed', detail: 'npm ERR!' });
    await s.o.pulse();
    expect(s.decide).toHaveBeenCalledOnce(); // consumed: no repeat retry
  });

  it('drops a pending trigger once the user moves to a different context', async () => {
    const s = setup();
    await s.o.handle(act('typing'));
    await s.o.handle(terminalFail);
    await s.o.handle(act('reading'));
    await s.o.handle(runbook);
    await s.o.pulse();
    expect(s.decide).not.toHaveBeenCalled();
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

  it('C1: a chip click never carries an intentText, even though the composed prompt quotes the model-authored nudge text', async () => {
    const s = setup();
    await s.o.handle(runbook);
    await s.o.tick();
    await s.o.handle({ v: 1, type: 'chip', nudgeId: 'n1', choice: 'check deploys' });
    expect(s.reply.mock.calls[0]![1].intentText).toBeUndefined();
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

describe('diagnostics logging (counts only)', () => {
  const spyLog = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  it('logs context_in on the first message, on app change, and on a >50-char ocrChars swing, but not on small swings', async () => {
    const log = spyLog();
    const s = setup({ log });
    await s.o.handle(ctx({ app: 'Chrome', bundleId: 'com.google.Chrome', ocrText: 'a'.repeat(10) }));
    expect(log.info).toHaveBeenCalledWith('context_in', {
      app: 'Chrome', bundleId: 'com.google.Chrome', private: false, titleChars: 'supply-prd latency - Grafana'.length,
      urlPresent: true, selectionChars: 0, ocrChars: 10,
    });

    log.info.mockClear();
    await s.o.handle(ctx({ app: 'Chrome', bundleId: 'com.google.Chrome', ocrText: 'a'.repeat(30) })); // +20, under threshold
    expect(log.info).not.toHaveBeenCalledWith('context_in', expect.anything());

    await s.o.handle(ctx({ app: 'Chrome', bundleId: 'com.google.Chrome', ocrText: 'a'.repeat(90) })); // +60 from last logged, over threshold
    expect(log.info).toHaveBeenCalledWith('context_in', expect.objectContaining({ ocrChars: 90 }));

    log.info.mockClear();
    await s.o.handle(ctx({ app: 'Slack', bundleId: 'com.slack.Slack', ocrText: 'a'.repeat(90) })); // app changed, same ocrChars
    expect(log.info).toHaveBeenCalledWith('context_in', expect.objectContaining({ app: 'Slack', bundleId: 'com.slack.Slack' }));
  });

  it('logs context_in for private contexts too', async () => {
    const log = spyLog();
    const s = setup({ log });
    await s.o.handle(ctx({ private: true, app: '1Password', bundleId: 'com.agilebits.onepassword7', windowTitle: '', url: undefined, selection: undefined, ocrText: undefined }));
    expect(log.info).toHaveBeenCalledWith('context_in', {
      app: '1Password', bundleId: 'com.agilebits.onepassword7', private: true, titleChars: 0, urlPresent: false, selectionChars: 0, ocrChars: 0,
    });
  });

  it('logs chat_ctx right before consulting chat.reply', async () => {
    const log = spyLog();
    const s = setup({ log });
    await s.o.handle(runbook);
    log.info.mockClear();
    await s.o.handle({ v: 1, type: 'utterance', text: 'what is on my screen?', source: 'chat' });
    expect(log.info).toHaveBeenCalledWith('chat_ctx', {
      hasCurrent: true, app: runbook.app, bundleId: runbook.bundleId, private: false, ocrChars: runbook.ocrText!.length, timelineEntries: 1,
    });
    expect(s.reply).toHaveBeenCalledOnce();
  });

  it('logs chat_ctx with hasCurrent=false and no timeline entries when nothing has been seen yet', async () => {
    const log = spyLog();
    const s = setup({ log });
    await s.o.handle({ v: 1, type: 'utterance', text: 'hi', source: 'chat' });
    expect(log.info).toHaveBeenCalledWith('chat_ctx', {
      hasCurrent: false, app: undefined, bundleId: undefined, private: undefined, ocrChars: 0, timelineEntries: 0,
    });
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

describe('clear chat', () => {
  it('"clear chat" clears memory turns and confirms, without consulting chat or the decider', async () => {
    const s = setup();
    s.memory.addTurn('user', 'hi', T0);
    s.memory.addTurn('assistant', 'hello', T0);
    await s.o.handle({ v: 1, type: 'utterance', text: 'clear chat', source: 'chat' });
    expect(s.memory.recentTurns(10)).toEqual([]);
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: 'Chat cleared. Fresh start.' });
    expect(s.reply).not.toHaveBeenCalled();
    expect(s.decide).not.toHaveBeenCalled();
  });

  it('"forget this chat" (case/whitespace-insensitive) also clears memory turns', async () => {
    const s = setup();
    s.memory.addTurn('user', 'hi', T0);
    await s.o.handle({ v: 1, type: 'utterance', text: '  Forget This Chat  ', source: 'chat' });
    expect(s.memory.recentTurns(10)).toEqual([]);
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: 'Chat cleared. Fresh start.' });
    expect(s.reply).not.toHaveBeenCalled();
  });
});

describe('model health', () => {
  it('a model error flips to offline once (sleepy + status); recovery is announced only after a successful model call', async () => {
    const s = setup();
    s.decide.mockRejectedValueOnce(new ModelUnavailableError('down'));
    await s.o.handle(runbook);
    await s.o.tick();
    expect(s.moods().at(-1)).toBe('sleepy');
    expect(s.says().filter((m) => m.kind === 'status').map((m) => m.text)).toEqual(["Brain offline: Ollama isn't answering. I'll keep checking."]);

    s.health.mockResolvedValue(false);
    await s.o.checkHealth();
    s.advance(200_000);
    await s.o.tick();
    expect(s.decide).toHaveBeenCalledOnce(); // still offline: tick doesn't consult the model at all

    s.health.mockResolvedValue(true);
    await s.o.checkHealth();
    // health() true clears the gate but must not itself say "I'm back"
    expect(s.says().filter((m) => m.kind === 'status')).toHaveLength(1);

    s.decide.mockResolvedValue(decision);
    await s.o.tick();
    expect(s.decide).toHaveBeenCalledTimes(2);
    expect(s.says().filter((m) => m.kind === 'status').map((m) => m.text)).toEqual([
      "Brain offline: Ollama isn't answering. I'll keep checking.",
      "I'm back. Brain's online.",
    ]);
    expect(s.moods().at(-1)).toBe('curious');
  });

  it('suppresses the offline bubble while busy, but still flips mood to sleepy', async () => {
    const s = setup();
    await s.o.handle(act('in_call'));
    s.health.mockResolvedValue(false);
    await s.o.checkHealth();
    expect(s.moods().at(-1)).toBe('sleepy');
    expect(s.says()).toHaveLength(0);
  });

  it('backs off repeated health checks while offline (15s, then 30s, then 60s)', async () => {
    const s = setup();
    s.health.mockResolvedValue(false);
    await s.o.checkHealth();
    expect(s.health).toHaveBeenCalledTimes(1);
    s.advance(10_000);
    await s.o.checkHealth(); // within the 15s backoff window
    expect(s.health).toHaveBeenCalledTimes(1);
    s.advance(6_000); // 16s since the last check
    await s.o.checkHealth();
    expect(s.health).toHaveBeenCalledTimes(2);
    s.advance(25_000); // within the 30s backoff window
    await s.o.checkHealth();
    expect(s.health).toHaveBeenCalledTimes(2);
    s.advance(10_000); // 35s since the last check
    await s.o.checkHealth();
    expect(s.health).toHaveBeenCalledTimes(3);
  });

  it('resets the backoff to 15s once recovered', async () => {
    const s = setup();
    s.health.mockResolvedValue(false);
    await s.o.checkHealth(); // fails -> backoff 15s
    expect(s.health).toHaveBeenCalledTimes(1);
    s.advance(16_000);
    await s.o.checkHealth(); // fails again -> backoff 30s
    expect(s.health).toHaveBeenCalledTimes(2);
    s.advance(30_000); // past the 30s window
    s.health.mockResolvedValue(true);
    await s.o.checkHealth(); // recovers -> backoff resets
    expect(s.health).toHaveBeenCalledTimes(3);
    s.health.mockResolvedValue(false);
    await s.o.checkHealth(); // fresh offline period: not gated (was online), backoff starts at 15s again, not 60s
    expect(s.health).toHaveBeenCalledTimes(4);
    s.advance(10_000);
    await s.o.checkHealth(); // within the fresh 15s window -> skipped
    expect(s.health).toHaveBeenCalledTimes(4);
    s.advance(6_000); // 16s since the last check
    await s.o.checkHealth();
    expect(s.health).toHaveBeenCalledTimes(5);
  });

  it('a ModelRequestError is logged as "no decision" and does not flip offline', async () => {
    const s = setup();
    s.decide.mockRejectedValueOnce(new ModelRequestError('bad schema'));
    await s.o.handle(runbook);
    await s.o.tick();
    expect(s.says()).toHaveLength(0);
    expect(s.moods().at(-1)).not.toBe('sleepy');
    s.decide.mockResolvedValue(decision);
    await s.o.tick();
    expect(s.says().at(-1)).toMatchObject({ kind: 'suggestion' });
  });

  it('chat while offline gets one clear answer instead of silence', async () => {
    const s = setup();
    s.health.mockResolvedValue(false);
    await s.o.checkHealth();
    s.reply.mockRejectedValue(new ModelUnavailableError('down'));
    await s.o.handle({ v: 1, type: 'utterance', text: 'hello?', source: 'chat' });
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: "My brain's offline right now (Ollama isn't answering). I'll be back when it is." });
  });

  it('a chat reply that succeeds before checkHealth catches up also clears offline and announces recovery', async () => {
    const s = setup();
    s.decide.mockRejectedValueOnce(new ModelUnavailableError('down'));
    await s.o.handle(runbook);
    await s.o.tick(); // goes offline
    expect(s.moods().at(-1)).toBe('sleepy');

    await s.o.handle({ v: 1, type: 'utterance', text: 'hello?', source: 'chat' }); // reply succeeds (default mock)
    expect(s.reply).toHaveBeenCalledOnce();
    // the recovery bubble is announced before the reply itself
    expect(s.says().slice(-2)).toMatchObject([{ kind: 'status', text: "I'm back. Brain's online." }, { kind: 'reply', text: 'An answer.' }]);
    expect(s.moods().at(-1)).toBe('curious');

    await s.o.tick(); // online again: tick can consult the model without help from checkHealth
    expect(s.decide).toHaveBeenCalledTimes(2);
  });

  it('re-sends the current mood when the body reconnects', async () => {
    const s = setup();
    await s.o.handle(runbook);
    const before = s.moods().length;
    s.o.onBodyConnected();
    expect(s.moods().length).toBe(before + 1);
  });
});

describe('focus commands', () => {
  it('sends a focus message for a "go to X" utterance instead of consulting chat or the decider', async () => {
    const s = setup();
    await s.o.handle({ v: 1, type: 'utterance', text: 'go to slack', source: 'chat' });
    expect(s.reply).not.toHaveBeenCalled();
    expect(s.decide).not.toHaveBeenCalled();
    expect(s.sent.filter((m) => m.type === 'focus')).toEqual([
      { v: 1, type: 'focus', requestId: 'n1', target: 'slack', kind: 'app' },
    ]);
  });

  it('says "Switched to X" once the body confirms a match', async () => {
    const s = setup();
    await s.o.handle({ v: 1, type: 'utterance', text: 'go to slack', source: 'chat' });
    await s.o.handle({ v: 1, type: 'focus_result', requestId: 'n1', ok: true, matched: 'Slack' });
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: 'Switched to Slack.' });
  });

  it('reports a miss by app name when the body can\'t find the target', async () => {
    const s = setup();
    await s.o.handle({ v: 1, type: 'utterance', text: 'go to figma', source: 'chat' });
    await s.o.handle({ v: 1, type: 'focus_result', requestId: 'n1', ok: false });
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: 'I can\'t find an app called "figma".' });
  });

  it('ignores a focus_result whose requestId does not match the pending focus', async () => {
    const s = setup();
    await s.o.handle({ v: 1, type: 'utterance', text: 'go to slack', source: 'chat' });
    await s.o.handle({ v: 1, type: 'focus_result', requestId: 'stale', ok: true, matched: 'Slack' });
    expect(s.says()).toHaveLength(0);
  });

  it('says the switch did not go through after 20s with no result (I5: long enough for a cold launch)', async () => {
    const s = setup();
    await s.o.handle({ v: 1, type: 'utterance', text: 'go to slack', source: 'chat' });
    s.advance(20_000);
    await s.o.pulse();
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: "That switch didn't go through." });
    await s.o.handle({ v: 1, type: 'focus_result', requestId: 'n1', ok: true, matched: 'Slack' });
    expect(s.says()).toHaveLength(1); // the late result is ignored: pending was already cleared
  });

  it('never sends a focus message for a chip click, even one whose choice reads like a command', async () => {
    const s = setup();
    await s.o.handle(runbook);
    await s.o.tick();
    await s.o.handle({ v: 1, type: 'chip', nudgeId: 'n1', choice: 'go to slack' });
    expect(s.sent.filter((m) => m.type === 'focus')).toHaveLength(0);
    expect(s.reply).toHaveBeenCalledOnce();
  });
});

describe('open url commands', () => {
  it('sends an open_url message for "open youtube" instead of consulting chat or the decider', async () => {
    const s = setup();
    await s.o.handle({ v: 1, type: 'utterance', text: 'open youtube', source: 'chat' });
    expect(s.reply).not.toHaveBeenCalled();
    expect(s.decide).not.toHaveBeenCalled();
    expect(s.sent.filter((m) => m.type === 'open_url')).toEqual([
      { v: 1, type: 'open_url', requestId: 'n1', url: 'https://www.youtube.com' },
    ]);
  });

  it('passes the browser through when the utterance names one', async () => {
    const s = setup();
    await s.o.handle({ v: 1, type: 'utterance', text: 'open youtube in chrome', source: 'chat' });
    expect(s.sent.filter((m) => m.type === 'open_url')).toEqual([
      { v: 1, type: 'open_url', requestId: 'n1', url: 'https://www.youtube.com', browser: 'chrome' },
    ]);
  });

  it('says "Opening <label> in <browser>…" once the body confirms it opened, using a browser name the body can actually produce', async () => {
    const s = setup();
    await s.o.handle({ v: 1, type: 'utterance', text: 'open youtube', source: 'chat' });
    // I3: `opened` is just the resolved browser's own display name (from NSWorkspace) — the body has no way
    // to know the site's label, so it can never itself produce "YouTube in Chrome"; the label comes from
    // the brain's own pending-open state, combined with the body's browser name here.
    await s.o.handle({ v: 1, type: 'open_url_result', requestId: 'n1', ok: true, opened: 'Google Chrome' });
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: 'Opening YouTube in Google Chrome…' });
  });

  it('falls back to the site label when the result carries no opened detail', async () => {
    const s = setup();
    await s.o.handle({ v: 1, type: 'utterance', text: 'open youtube', source: 'chat' });
    await s.o.handle({ v: 1, type: 'open_url_result', requestId: 'n1', ok: true });
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: 'Opening YouTube…' });
  });

  it('reports a miss honestly when the body could not open it', async () => {
    const s = setup();
    await s.o.handle({ v: 1, type: 'utterance', text: 'open youtube', source: 'chat' });
    await s.o.handle({ v: 1, type: 'open_url_result', requestId: 'n1', ok: false, error: 'no default browser found' });
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: "I couldn't open YouTube." });
  });

  it('ignores an open_url_result whose requestId does not match the pending open', async () => {
    const s = setup();
    await s.o.handle({ v: 1, type: 'utterance', text: 'open youtube', source: 'chat' });
    await s.o.handle({ v: 1, type: 'open_url_result', requestId: 'stale', ok: true });
    expect(s.says()).toHaveLength(0);
  });

  it('says it did not open after 20s with no result (I5: long enough for a cold launch)', async () => {
    const s = setup();
    await s.o.handle({ v: 1, type: 'utterance', text: 'open youtube', source: 'chat' });
    s.advance(20_000);
    await s.o.pulse();
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: "That didn't open." });
    await s.o.handle({ v: 1, type: 'open_url_result', requestId: 'n1', ok: true });
    expect(s.says()).toHaveLength(1); // the late result is ignored: pending was already cleared
  });

  it('M4: an overlong search query (url over 2048 chars) does not leave a dangling pendingOpen — it fails immediately, honestly, with no later false timeout', async () => {
    const s = setup();
    const longQuery = 'a'.repeat(2500);
    await s.o.handle({ v: 1, type: 'utterance', text: `search ${longQuery} on youtube`, source: 'chat' });
    expect(s.sent.filter((m) => m.type === 'open_url')).toHaveLength(0); // never actually sent — validation failed first
    expect(s.says()).toHaveLength(1);
    expect(s.says()[0]!.text).not.toMatch(/^Opening/);
    // Pending state was never set, so advancing past the timeout produces no further, spuriously-timed say.
    s.advance(20_000);
    await s.o.pulse();
    expect(s.says()).toHaveLength(1);
  });
});

describe('model-proposed actions', () => {
  const utter = (text: string) => ({ v: 1 as const, type: 'utterance' as const, text, source: 'chat' as const });

  it('executes a model-proposed url action without double-recording the user turn (chat.reply already did)', async () => {
    const s = setup();
    s.reply.mockResolvedValue({ text: 'On it.', draft: null, action: { open: 'url', url: 'https://www.youtube.com/results?search_query=dp', label: 'dp on YouTube' } });
    const text = 'can you help me find a dp video';
    await s.o.handle(utter(text));
    expect(s.sent.filter((m) => m.type === 'open_url')).toEqual([
      { v: 1, type: 'open_url', requestId: 'n2', url: 'https://www.youtube.com/results?search_query=dp' },
    ]);
    // chat.reply() is mocked here (its own memory recording is covered by chat.test.ts); this only proves
    // the orchestrator itself doesn't ALSO record the turn when executing a model action.
    expect(s.memory.recentTurns(5)).toEqual([]);
    await s.o.handle({ v: 1, type: 'open_url_result', requestId: 'n2', ok: true });
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: 'Opening dp on YouTube…' });
  });

  it('executes a model-proposed app action via the same focus flow as a parsed command', async () => {
    const s = setup();
    s.reply.mockResolvedValue({ text: 'Bringing up Arc.', draft: null, action: { open: 'app', target: 'Arc' } });
    await s.o.handle(utter('can you get Arc going'));
    expect(s.sent.filter((m) => m.type === 'focus')).toEqual([{ v: 1, type: 'focus', requestId: 'n2', target: 'Arc', kind: 'app' }]);
    await s.o.handle({ v: 1, type: 'focus_result', requestId: 'n2', ok: true, matched: 'Arc' });
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: 'Switched to Arc.' });
  });

  it('sends no reply bubble when the model line was dropped (empty text) alongside a pending action', async () => {
    const s = setup();
    s.reply.mockResolvedValue({ text: '', draft: null, action: { open: 'app', target: 'Arc' } });
    await s.o.handle(utter('can you get Arc going'));
    expect(s.says()).toHaveLength(0);
    expect(s.sent.filter((m) => m.type === 'focus')).toHaveLength(1);
  });

  it('does nothing extra when the reply carries no action', async () => {
    const s = setup();
    s.reply.mockResolvedValue({ text: 'An answer.', draft: null });
    await s.o.handle(utter('what is this'));
    expect(s.sent.filter((m) => m.type === 'focus' || m.type === 'open_url')).toHaveLength(0);
  });

  describe('M7: a model-chosen url that is not a known-site result is confirmed first', () => {
    const specificVideo = { open: 'url' as const, url: 'https://www.youtube.com/watch?v=xyz', label: 'Aditya Verma DP playlist' };

    it('does not auto-open; sends the reply with "Open <host>"/"dismiss" chips instead', async () => {
      const s = setup();
      s.reply.mockResolvedValue({ text: 'Found it.', draft: null, action: specificVideo });
      await s.o.handle(utter('open that dp playlist'));
      expect(s.sent.filter((m) => m.type === 'open_url' || m.type === 'focus')).toHaveLength(0);
      expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: 'Found it.', chips: ['Open www.youtube.com', 'dismiss'] });
    });

    it('uses a fallback question when the model line was dropped (empty text) alongside the pending confirm', async () => {
      const s = setup();
      s.reply.mockResolvedValue({ text: '', draft: null, action: specificVideo });
      await s.o.handle(utter('open that dp playlist'));
      expect(s.says().at(-1)).toMatchObject({ text: 'Want me to open Aditya Verma DP playlist?', chips: ['Open www.youtube.com', 'dismiss'] });
    });

    it('opens it once the user clicks "Open <host>"', async () => {
      const s = setup();
      s.reply.mockResolvedValue({ text: 'Found it.', draft: null, action: specificVideo });
      await s.o.handle(utter('open that dp playlist'));
      const nudgeId = s.says().at(-1)!.nudgeId;
      await s.o.handle({ v: 1, type: 'chip', nudgeId, choice: 'Open www.youtube.com' });
      expect(s.sent.filter((m) => m.type === 'open_url')).toEqual([
        { v: 1, type: 'open_url', requestId: expect.any(String), url: 'https://www.youtube.com/watch?v=xyz' },
      ]);
      await s.o.handle({ v: 1, type: 'open_url_result', requestId: s.sent.find((m) => m.type === 'open_url')!.requestId, ok: true });
      expect(s.says().at(-1)).toMatchObject({ text: 'Opening Aditya Verma DP playlist…' });
    });

    it('never opens it on "dismiss" — treated as an ordinary ignored chip', async () => {
      const s = setup();
      s.reply.mockResolvedValue({ text: 'Found it.', draft: null, action: specificVideo });
      await s.o.handle(utter('open that dp playlist'));
      const nudgeId = s.says().at(-1)!.nudgeId;
      await s.o.handle({ v: 1, type: 'chip', nudgeId, choice: 'dismiss' });
      expect(s.sent.filter((m) => m.type === 'open_url')).toHaveLength(0);
    });

    it('does not open a stale confirm click past the 2-minute window — falls through to an ordinary chip reply instead', async () => {
      const s = setup();
      s.reply.mockResolvedValue({ text: 'Found it.', draft: null, action: specificVideo });
      await s.o.handle(utter('open that dp playlist'));
      const nudgeId = s.says().at(-1)!.nudgeId;
      s.advance(121_000);
      s.reply.mockResolvedValue({ text: 'An answer.', draft: null });
      await s.o.handle({ v: 1, type: 'chip', nudgeId, choice: 'Open www.youtube.com' });
      expect(s.sent.filter((m) => m.type === 'open_url')).toHaveLength(0);
      expect(s.reply).toHaveBeenCalledTimes(2); // fell through to the normal "answer the chip" path
    });

    it('does not require confirmation for a known-site result (homepage or one of our own search templates)', async () => {
      const s = setup();
      s.reply.mockResolvedValue({
        text: 'On it.',
        draft: null,
        action: { open: 'url', url: 'https://www.youtube.com/results?search_query=dp', label: 'dp on YouTube' },
      });
      await s.o.handle(utter('can you find a dp search for me'));
      expect(s.sent.filter((m) => m.type === 'open_url')).toHaveLength(1);
      expect(s.says().at(-1)?.chips ?? []).not.toContain(expect.stringMatching(/^Open /));
    });

    it('N5: replaces a non-empty line that implies the open already happened, not just an empty one', async () => {
      const s = setup();
      s.reply.mockResolvedValue({ text: 'Opening that for you now.', draft: null, action: specificVideo });
      await s.o.handle(utter('open that dp playlist'));
      expect(s.says().at(-1)).toMatchObject({ text: 'Want me to open Aditya Verma DP playlist?', chips: ['Open www.youtube.com', 'dismiss'] });
      expect(s.sent.filter((m) => m.type === 'open_url')).toHaveLength(0);
    });

    it('N5: leaves an ordinary (non-pending-implying) line next to the confirm chips alone', async () => {
      const s = setup();
      s.reply.mockResolvedValue({ text: 'Found the DP playlist you meant.', draft: null, action: specificVideo });
      await s.o.handle(utter('open that dp playlist'));
      expect(s.says().at(-1)).toMatchObject({ text: 'Found the DP playlist you meant.', chips: ['Open www.youtube.com', 'dismiss'] });
    });

    it('N5: drops the open action entirely when the reply also carries a draft, rather than combining chip sets or auto-opening', async () => {
      const s = setup();
      s.reply.mockResolvedValue({ text: 'Here you go.', draft: "I'll check that playlist later.", action: specificVideo });
      await s.o.handle(utter('open that dp playlist'));
      expect(s.sent.filter((m) => m.type === 'open_url' || m.type === 'focus')).toHaveLength(0);
      const last = s.says().at(-1)!;
      expect(last.draft).toBe("I'll check that playlist later.");
      expect(last.chips ?? []).not.toContain(expect.stringMatching(/^Open /));
      // No pendingUrlConfirm was left dangling either: a later click on some other chip with this nudgeId
      // must not open anything.
      await s.o.handle({ v: 1, type: 'chip', nudgeId: last.nudgeId, choice: 'Open www.youtube.com' });
      expect(s.sent.filter((m) => m.type === 'open_url')).toHaveLength(0);
    });
  });

  it('passes the raw utterance as ctx.intentText for a normal utterance turn', async () => {
    const s = setup();
    s.reply.mockResolvedValue({ text: 'An answer.', draft: null });
    await s.o.handle(utter('can you get Arc going'));
    expect(s.reply.mock.calls[0]![1].intentText).toBe('can you get Arc going');
  });

  it("C1 regression (reviewer's probe): a nudge whose text contains an action verb, then a chip click, then a model reply carrying an action, produces no open_url/focus message", async () => {
    const s = setup();
    // Mirrors the real gate in chat.ts: an action is only ever included when intentText is present. This
    // is the load-bearing assertion — if orchestrator.ts ever passed a truthy intentText for a chip click
    // (e.g. the composed prompt text, which contains "open" here), this mock would wrongly include the
    // action and the test would fail alongside the real production gate.
    s.reply.mockImplementation((_text, ctx) =>
      Promise.resolve({
        text: 'On it.',
        draft: null,
        ...(ctx.intentText !== undefined ? { action: { open: 'url' as const, url: 'https://evil.example/login', label: 'evil' } } : {}),
      }),
    );
    const openingNudge: NudgeDecision = { speak: true, kind: 'suggestion', text: 'Want me to open the runbook?', chips: ['explain the jump'], pointAt: null };
    s.decide.mockResolvedValue(openingNudge);
    await s.o.handle(runbook);
    await s.o.tick();
    await s.o.handle({ v: 1, type: 'chip', nudgeId: 'n1', choice: 'explain the jump' });
    expect(s.reply.mock.calls[0]![0]).toBe('I clicked "explain the jump" on what you said: "Want me to open the runbook?"');
    expect(s.reply.mock.calls[0]![1].intentText).toBeUndefined();
    expect(s.sent.filter((m) => m.type === 'open_url' || m.type === 'focus')).toHaveLength(0);
  });
});

describe('following through on focus offers', () => {
  const offer: NudgeDecision = { speak: true, kind: 'suggestion', text: "You missed the pulse mcp request in Prince's DM. Want me to bring the Slack window to the front?", chips: [], pointAt: null };
  const utter = (text: string) => ({ v: 1 as const, type: 'utterance' as const, text, source: 'chat' as const });
  const focuses = (s: ReturnType<typeof setup>) => s.sent.filter((m) => m.type === 'focus');

  async function offered() {
    const s = setup();
    s.decide.mockResolvedValue(offer);
    await s.o.handle(runbook);
    await s.o.tick();
    return s;
  }

  it('runs the focus flow when the user says "sure" to a nudge offering to bring an app to the front', async () => {
    const s = await offered();
    await s.o.handle(utter('sure'));
    expect(s.reply).not.toHaveBeenCalled();
    expect(focuses(s)).toEqual([{ v: 1, type: 'focus', requestId: 'n2', target: 'slack', kind: 'app' }]);
    await s.o.handle({ v: 1, type: 'focus_result', requestId: 'n2', ok: true, matched: 'Slack' });
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: 'Switched to Slack.' });
  });

  it('follows through on an offer made in a chat reply', async () => {
    const s = setup();
    s.reply.mockResolvedValue({ text: 'Prince asked about pulse mcp. Want me to bring Slack to the front?', draft: null });
    await s.o.handle(utter('what did I miss?'));
    await s.o.handle(utter('yes please'));
    expect(s.reply).toHaveBeenCalledOnce();
    expect(focuses(s)).toEqual([{ v: 1, type: 'focus', requestId: 'n2', target: 'slack', kind: 'app' }]);
  });

  it('lets the offer expire after 120 s: a late "sure" goes to chat', async () => {
    const s = await offered();
    s.advance(121_000);
    await s.o.handle(utter('sure'));
    expect(focuses(s)).toHaveLength(0);
    expect(s.reply).toHaveBeenCalledWith('sure', expect.anything());
  });

  it('clears the offer on any other user message', async () => {
    const s = await offered();
    await s.o.handle(utter('what is pulse mcp?'));
    await s.o.handle(utter('sure'));
    expect(focuses(s)).toHaveLength(0);
    expect(s.reply).toHaveBeenCalledTimes(2);
  });

  it('only follows through once per offer', async () => {
    const s = await offered();
    await s.o.handle(utter('sure'));
    await s.o.handle(utter('ok'));
    expect(focuses(s)).toHaveLength(1);
    expect(s.reply).toHaveBeenCalledWith('ok', expect.anything());
  });

  it('sends an affirmation with no pending offer to chat as before', async () => {
    const s = setup();
    await s.o.handle(utter('sure'));
    expect(focuses(s)).toHaveLength(0);
    expect(s.reply).toHaveBeenCalledWith('sure', expect.anything());
  });

  it('drops the offer when a later Coco message makes no offer', async () => {
    const s = await offered();
    s.reply.mockResolvedValue({ text: 'Pulse mcp is the metrics bridge.', draft: null });
    await s.o.handle(utter('what is pulse mcp?'));
    await s.o.handle(utter('sure'));
    expect(focuses(s)).toHaveLength(0);
  });
});

describe('draft & paste', () => {
  const utter = (text: string) => ({ v: 1 as const, type: 'utterance' as const, text, source: 'chat' as const });
  const pasteMsgs = (s: ReturnType<typeof setup>) => s.sent.filter((m): m is PasteMsg => m.type === 'paste');
  const draftReply = { text: 'Here you go.', draft: "I'll check the pulse mcp setup tomorrow morning." };

  it('a draft reply on a known, non-private app carries draft, draftApp and a "paste into <App>" chip', async () => {
    const s = setup();
    s.reply.mockResolvedValue(draftReply);
    await s.o.handle(runbook); // app: Arc, private: false
    await s.o.handle(utter('draft a reply to Prince'));
    expect(s.says().at(-1)).toMatchObject({
      kind: 'reply',
      text: draftReply.text,
      draft: draftReply.draft,
      draftApp: 'Arc',
      chips: ['paste into Arc'],
    });
  });

  it('a draft reply with no current context carries the draft but no draftApp/chip', async () => {
    const s = setup();
    s.reply.mockResolvedValue(draftReply);
    await s.o.handle(utter('draft a reply to Prince'));
    const said = s.says().at(-1)!;
    expect(said).toMatchObject({ kind: 'reply', text: draftReply.text, draft: draftReply.draft, chips: [] });
    expect(said.draftApp).toBeUndefined();
  });

  it('a draft reply on a private context carries the draft but no draftApp/chip, and does not set lastDraft', async () => {
    const s = setup();
    s.reply.mockResolvedValue(draftReply);
    await s.o.handle(ctx({ private: true, app: '1Password', bundleId: 'com.agilebits.onepassword7', windowTitle: '', url: undefined, selection: undefined, ocrText: undefined }));
    await s.o.handle(utter('draft a reply to Prince'));
    const said = s.says().at(-1)!;
    expect(said).toMatchObject({ kind: 'reply', text: draftReply.text, draft: draftReply.draft, chips: [] });
    expect(said.draftApp).toBeUndefined();
    // lastDraft was never set: "paste it" has nothing to paste, and no paste message is sent.
    await s.o.handle(utter('paste it'));
    expect(pasteMsgs(s)).toHaveLength(0);
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: "There's no draft to paste yet." });
  });

  it('clicking the "paste into <App>" chip on the say that carried the draft sends a paste with the exact draft text', async () => {
    const s = setup();
    s.reply.mockResolvedValue(draftReply);
    await s.o.handle(runbook);
    await s.o.handle(utter('draft a reply to Prince'));
    const nudgeId = s.says().at(-1)!.nudgeId;
    await s.o.handle({ v: 1, type: 'chip', nudgeId, choice: 'paste into Arc' });
    expect(pasteMsgs(s)).toHaveLength(1);
    expect(pasteMsgs(s)[0]).toMatchObject({ v: 1, type: 'paste', text: draftReply.draft, app: 'Arc' });
  });

  it('a chip labelled "paste into" whose nudgeId does not match the draft-carrying say falls through to chat instead', async () => {
    const s = setup();
    s.reply.mockResolvedValue(draftReply);
    await s.o.handle(runbook);
    await s.o.handle(utter('draft a reply to Prince'));
    await s.o.handle({ v: 1, type: 'chip', nudgeId: 'stale-id', choice: 'paste into Arc' });
    expect(pasteMsgs(s)).toHaveLength(0);
    expect(s.reply).toHaveBeenCalledWith('paste into Arc', expect.anything());
  });

  it('typing "paste it" (or variants) triggers a paste from the last draft', async () => {
    const s = setup();
    s.reply.mockResolvedValue(draftReply);
    await s.o.handle(runbook);
    await s.o.handle(utter('draft a reply to Prince'));
    await s.o.handle(utter('paste it'));
    expect(pasteMsgs(s)).toHaveLength(1);
    expect(pasteMsgs(s)[0]).toMatchObject({ v: 1, type: 'paste', text: draftReply.draft, app: 'Arc' });
    expect(s.reply).toHaveBeenCalledOnce(); // "paste it" itself never reaches chat
  });

  it('"paste it" with no draft replies that there is nothing to paste, and sends no paste message', async () => {
    const s = setup();
    await s.o.handle(utter('paste it'));
    expect(pasteMsgs(s)).toHaveLength(0);
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: "There's no draft to paste yet." });
    expect(s.reply).not.toHaveBeenCalled();
  });

  it('a stale draft (10+ minutes old) does not trigger a paste', async () => {
    const s = setup();
    s.reply.mockResolvedValue(draftReply);
    await s.o.handle(runbook);
    await s.o.handle(utter('draft a reply to Prince'));
    s.advance(10 * 60_000);
    await s.o.handle(utter('paste it'));
    expect(pasteMsgs(s)).toHaveLength(0);
  });

  it('nudges from the decider never carry a draft or a paste chip', async () => {
    const s = setup();
    await s.o.handle(runbook);
    await s.o.tick();
    const said = s.says().at(-1)!;
    expect(said.draft).toBeUndefined();
    expect(said.draftApp).toBeUndefined();
    expect(said.chips.some((c) => c.toLowerCase().startsWith('paste into'))).toBe(false);
  });

  it('a successful paste_result confirms the paste and tells the user to press Enter', async () => {
    const s = setup();
    s.reply.mockResolvedValue(draftReply);
    await s.o.handle(runbook);
    await s.o.handle(utter('draft a reply to Prince'));
    await s.o.handle(utter('paste it'));
    const requestId = pasteMsgs(s)[0]!.requestId;
    await s.o.handle({ v: 1, type: 'paste_result', requestId, ok: true });
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: 'Pasted into Arc — press Enter to send.' });
  });

  it('a failed paste_result reports the detail, or a generic reason when none is given', async () => {
    const s = setup();
    s.reply.mockResolvedValue(draftReply);
    await s.o.handle(runbook);
    await s.o.handle(utter('draft a reply to Prince'));
    await s.o.handle(utter('paste it'));
    const requestId = pasteMsgs(s)[0]!.requestId;
    await s.o.handle({ v: 1, type: 'paste_result', requestId, ok: false, detail: 'Accessibility permission is off' });
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: "Couldn't paste into Arc: Accessibility permission is off." });
  });

  it('a failed paste_result with no detail falls back to "no text box found"', async () => {
    const s = setup();
    s.reply.mockResolvedValue(draftReply);
    await s.o.handle(runbook);
    await s.o.handle(utter('draft a reply to Prince'));
    await s.o.handle(utter('paste it'));
    const requestId = pasteMsgs(s)[0]!.requestId;
    await s.o.handle({ v: 1, type: 'paste_result', requestId, ok: false });
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: "Couldn't paste into Arc: no text box found." });
  });

  it('a paste that gets no result within 5s says the paste did not go through', async () => {
    const s = setup();
    s.reply.mockResolvedValue(draftReply);
    await s.o.handle(runbook);
    await s.o.handle(utter('draft a reply to Prince'));
    await s.o.handle(utter('paste it'));
    s.advance(5000);
    await s.o.pulse();
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: "The paste didn't go through." });
    // a late result after the timeout is ignored: pending was already cleared
    const requestId = pasteMsgs(s)[0]!.requestId;
    await s.o.handle({ v: 1, type: 'paste_result', requestId, ok: true });
    expect(s.says().at(-1)).toMatchObject({ text: "The paste didn't go through." });
  });
});

describe('voice (SayMsg.speak)', () => {
  const utter = (text: string, source: 'voice' | 'chat' = 'chat') => ({ v: 1 as const, type: 'utterance' as const, text, source });
  const withVoice = (voice: Partial<typeof DEFAULT_CONFIG.voice>) =>
    setup({ config: { ...DEFAULT_CONFIG, user: { name: 'Roshni', handles: ['roshni'] }, voice: { ...DEFAULT_CONFIG.voice, ...voice } } });

  it('a reply to a voice utterance speaks when voice is enabled', async () => {
    const s = withVoice({});
    await s.o.handle(utter('what is this?', 'voice'));
    expect(s.says().at(-1)).toMatchObject({ kind: 'reply', text: 'An answer.', speak: true });
  });

  it('a reply to typed chat does not speak by default, but does when speakTypedReplies is on', async () => {
    const quiet = withVoice({});
    await quiet.o.handle(utter('what is this?', 'chat'));
    expect(quiet.says().at(-1)).toMatchObject({ kind: 'reply', speak: false });

    const loud = withVoice({ speakTypedReplies: true });
    await loud.o.handle(utter('what is this?', 'chat'));
    expect(loud.says().at(-1)).toMatchObject({ kind: 'reply', speak: true });
  });

  it('an unsolicited nudge speaks when voice.enabled && voice.speakNudges', async () => {
    const s = withVoice({});
    await s.o.handle(runbook);
    await s.o.tick();
    expect(s.says().at(-1)).toMatchObject({ speak: true });

    const noNudges = withVoice({ speakNudges: false });
    await noNudges.o.handle(runbook);
    await noNudges.o.tick();
    expect(noNudges.says().at(-1)).toMatchObject({ speak: false });
  });

  it('voice.enabled=false silences everything: nudges, voice replies, and voice focus confirmations', async () => {
    const s = withVoice({ enabled: false });
    await s.o.handle(runbook);
    await s.o.tick();
    expect(s.says().at(-1)).toMatchObject({ speak: false });

    await s.o.handle(utter('what is this?', 'voice'));
    expect(s.says().at(-1)).toMatchObject({ speak: false });

    await s.o.handle(utter('go to slack', 'voice'));
    await s.o.handle({ v: 1, type: 'focus_result', requestId: s.sent.filter((m) => m.type === 'focus').at(-1)!.requestId, ok: true, matched: 'Slack' });
    expect(s.says().at(-1)).toMatchObject({ text: 'Switched to Slack.', speak: false });
  });

  it('a focus command confirmation speaks only when the command itself came by voice', async () => {
    const s = withVoice({});
    await s.o.handle(utter('go to slack', 'voice'));
    await s.o.handle({ v: 1, type: 'focus_result', requestId: 'n1', ok: true, matched: 'Slack' });
    expect(s.says().at(-1)).toMatchObject({ text: 'Switched to Slack.', speak: true });

    const typed = withVoice({});
    await typed.o.handle(utter('go to slack', 'chat'));
    await typed.o.handle({ v: 1, type: 'focus_result', requestId: 'n1', ok: true, matched: 'Slack' });
    expect(typed.says().at(-1)).toMatchObject({ text: 'Switched to Slack.', speak: false });
  });

  it('status says (e.g. brain offline) never speak, even with voice enabled', async () => {
    const s = withVoice({});
    s.decide.mockRejectedValueOnce(new ModelUnavailableError('down'));
    await s.o.handle(runbook);
    await s.o.tick();
    expect(s.says().at(-1)).toMatchObject({ kind: 'status', text: "Brain offline: Ollama isn't answering. I'll keep checking.", speak: false });
  });

  it('a draft reply speaks only via the say\'s text field, which never contains the draft body', async () => {
    const draftReply = { text: 'Here you go.', draft: "I'll check the pulse mcp setup tomorrow morning." };
    const s = withVoice({});
    s.reply.mockResolvedValue(draftReply);
    await s.o.handle(ctx({ app: 'Arc', bundleId: 'company.thebrowser.Browser', private: false }));
    await s.o.handle(utter('draft a reply to Prince', 'voice'));
    const said = s.says().at(-1)!;
    expect(said).toMatchObject({ text: draftReply.text, draft: draftReply.draft, speak: true });
    expect(said.text).not.toContain(draftReply.draft);
  });
});

describe('decision trace', () => {
  const utter = (text: string, source: 'voice' | 'chat' = 'chat') => ({ v: 1 as const, type: 'utterance' as const, text, source });

  function fakeTrace(): { [K in keyof DecisionTrace]: ReturnType<typeof vi.fn> } {
    return {
      startTurn: vi.fn(() => 'turn-1'),
      setRoute: vi.fn(),
      addModelCall: vi.fn(),
      setExtracted: vi.fn(),
      setGate: vi.fn(),
      addSent: vi.fn(),
      addResult: vi.fn(),
      finishTurn: vi.fn(),
      logNudgeDecision: vi.fn(),
      sweep: vi.fn(),
    };
  }

  function withRealTrace(overrides: Partial<OrchestratorDeps> = {}) {
    const logsDir = mkdtempSync(join(tmpdir(), 'coco-orch-trace-'));
    let n = 0;
    const trace = createFileTrace({ logsDir, clock: Date.now, newId: () => `turn${++n}` });
    const s = setup({ trace, ...overrides });
    const path = join(logsDir, 'trace.jsonl');
    const lines = (): Record<string, unknown>[] =>
      existsSync(path)
        ? readFileSync(path, 'utf8')
            .split('\n')
            .filter((l) => l !== '')
            .map((l) => JSON.parse(l))
        : [];
    return { ...s, lines };
  }

  it('routes every onUtterance branch to the matching `via`, sharing one turnId per turn', async () => {
    const s = setup({ trace: fakeTrace() });
    const trace = s.o['trace'] as ReturnType<typeof fakeTrace>;

    await s.o.handle(utter('go to slack')); // command
    await s.o.handle(utter('shh')); // mute
    await s.o.handle(utter('clear chat')); // clear
    await s.o.handle(utter('what is this?')); // model (falls through to chat.reply)

    const routes = trace.setRoute.mock.calls.map(([, route]: [string, { via: string }]) => route.via);
    expect(routes).toEqual(['command', 'mute', 'clear', 'model']);
    // Every startTurn call got an utterance recorded, and every setRoute call used that same turn's id.
    expect(trace.startTurn).toHaveBeenCalledTimes(4);
    for (const [turnId] of trace.setRoute.mock.calls) expect(turnId).toBe('turn-1');
  });

  it('routes an accepted focus offer to "offer" and a paste utterance to "paste"', async () => {
    const s = setup({ trace: fakeTrace() });
    const trace = s.o['trace'] as ReturnType<typeof fakeTrace>;
    s.reply.mockResolvedValueOnce({ text: 'Switch to Slack?', draft: null });
    await s.o.handle(utter('what should I do?'));
    await s.o.handle(utter('sure'));
    expect(trace.setRoute).toHaveBeenNthCalledWith(2, 'turn-1', { via: 'offer' });

    s.reply.mockResolvedValueOnce({ text: 'Here you go.', draft: 'hello' });
    await s.o.handle(ctx({ app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', private: false }));
    await s.o.handle(utter('draft a reply'));
    await s.o.handle(utter('paste'));
    expect(trace.setRoute).toHaveBeenLastCalledWith('turn-1', { via: 'paste' });
  });

  it('writes one real JSON line per turn, correlating a command\'s sent focus with its later result', async () => {
    const s = withRealTrace();
    await s.o.handle(utter('go to slack'));
    await s.o.handle({ v: 1, type: 'focus_result', requestId: 'n1', ok: true, matched: 'Slack' });

    const lines = s.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      turnId: 'turn1',
      utterance: { source: 'chat', text: 'go to slack' },
      route: { via: 'command', command: { type: 'focus', target: 'slack', kind: 'app' } },
      sent: [{ type: 'focus', payload: { target: 'slack', kind: 'app' } }],
      result: { type: 'focus_result', ok: true, matched: 'Slack' },
    });
  });

  it('finishes a mute/clear turn immediately, with a say `sent` and no `result` field', async () => {
    const s = withRealTrace();
    await s.o.handle(utter('shh'));
    const lines = s.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ route: { via: 'mute' }, sent: [{ type: 'say', payload: { text: TEXTMuted30() } }] });
    expect(lines[0]).not.toHaveProperty('result');
  });

  it('flushes a "command" turn on a focus timeout when no result ever arrives', async () => {
    const s = withRealTrace();
    await s.o.handle(utter('go to slack'));
    expect(s.lines()).toHaveLength(0); // still buffered, awaiting the result
    s.advance(20_000);
    await s.o.pulse();
    const lines = s.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ result: { type: 'focus_result', ok: false } });
  });

  it('records a model-routed turn end-to-end: model_call, extracted, gate, and the eventual focus result', async () => {
    const s = withRealTrace();
    s.reply.mockResolvedValueOnce({ text: 'Opening Slack.', draft: null, action: { open: 'app', target: 'Slack' } });
    await s.o.handle(utter('hey so could you open that chat app'));
    const focus = s.sent.find((m) => m.type === 'focus') as { requestId: string } | undefined;
    expect(focus).toBeDefined();
    await s.o.handle({ v: 1, type: 'focus_result', requestId: focus!.requestId, ok: true, matched: 'Slack' });

    const lines = s.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.route).toEqual({ via: 'model' });
    expect(lines[0]!.sent).toEqual([
      { type: 'say', payload: { text: 'Opening Slack.', hasDraft: false } },
      { type: 'focus', payload: { target: 'Slack', kind: 'app' } },
    ]);
    expect(lines[0]!.result).toMatchObject({ type: 'focus_result', ok: true, matched: 'Slack' });
  });

  it('finishes a model-routed turn immediately when no action executes (a plain reply)', async () => {
    const s = withRealTrace();
    s.reply.mockResolvedValueOnce({ text: 'That is Grafana.', draft: null });
    await s.o.handle(utter('what is this?'));
    const lines = s.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.route).toEqual({ via: 'model' });
    expect(lines[0]).not.toHaveProperty('result');
  });

  it('finishes the turn even when chat.reply throws', async () => {
    const s = withRealTrace();
    s.reply.mockRejectedValueOnce(new Error('boom'));
    await s.o.handle(utter('what is this?'));
    const lines = s.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.route).toEqual({ via: 'model' });
  });

  it('sweeps a stale, still-open turn from pulse() so it is never lost forever', async () => {
    const s = setup({ trace: fakeTrace() });
    const trace = s.o['trace'] as ReturnType<typeof fakeTrace>;
    await s.o.pulse();
    expect(trace.sweep).toHaveBeenCalled();
  });
});

function TEXTMuted30(): string {
  return "Muted for 30 minutes. I'll still answer if you ask.";
}

describe('tools', () => {
  const utter = (text: string) => ({ v: 1 as const, type: 'utterance' as const, text, source: 'chat' as const });
  const chip = (nudgeId: string, choice: string) => ({ v: 1 as const, type: 'chip' as const, nudgeId, choice });
  const pendingCall = { qualified: 'atlassian__createJiraIssue', serverId: 'atlassian', tool: 'createJiraIssue', args: { summary: 'x' }, reason: 'write_default' };
  const successfulRun = {
    qualified: 'atlassian__createJiraIssue', serverId: 'atlassian', tool: 'createJiraIssue', args: { summary: 'x' },
    result: { ok: true, text: 'created DEVOPS-1', ms: 5 }, decision: 'confirmed' as const,
  };
  const fakeTools = (gathered: Awaited<ReturnType<NonNullable<OrchestratorDeps['tools']>['gather']>>) => ({
    gather: vi.fn().mockResolvedValue(gathered),
    runConfirmed: vi.fn().mockResolvedValue({
      runs: [successfulRun],
      toolContext: '<untrusted source="mcp:atlassian/createJiraIssue">\nok\ncreated DEVOPS-1\n</untrusted>',
    }),
    recordDecision: vi.fn(),
  });

  it('passes gathered tool context into the chat reply', async () => {
    const tools = fakeTools({ runs: [], toolContext: 'CTX' });
    const s = setup({ tools });
    await s.o.handle(utter('status of jira DEVOPS-35236'));
    expect(tools.gather).toHaveBeenCalledWith({ utterance: 'status of jira DEVOPS-35236', untrustedText: '' });
    expect(s.reply.mock.calls[0]![1].toolResults).toBe('CTX');
  });

  it('asks before running a confirm tool, and runs it on "Run it"', async () => {
    const tools = fakeTools({ runs: [], pending: pendingCall, toolContext: '' });
    const s = setup({ tools });
    await s.o.handle(utter('create a jira issue for this bug'));
    expect(s.reply).not.toHaveBeenCalled();
    const ask = s.says().at(-1)!;
    expect(ask.text).toBe("I'd need to run createJiraIssue (atlassian) for that. Run it?");
    expect(ask.chips).toEqual(['Run it', 'Cancel']);
    await s.o.handle(chip(ask.nudgeId, 'Run it'));
    expect(tools.runConfirmed).toHaveBeenCalledWith(pendingCall);
    expect(tools.gather).toHaveBeenCalledTimes(1); // M8: the post-confirm answer must not gather again
    const ctx = s.reply.mock.calls[0]![1];
    expect(ctx.toolResults).toContain('created DEVOPS-1');
    expect(ctx.intentText).toBeUndefined();
    expect(ctx.toolSucceeded).toEqual({ tool: 'createJiraIssue', serverId: 'atlassian' }); // I3
    expect(ctx.recordUserTurn).toBe(false); // M4: the ask already recorded this user turn once
  });

  it('records the ask as an assistant turn, alongside the user turn (M4)', async () => {
    const tools = fakeTools({ runs: [], pending: pendingCall, toolContext: '' });
    const s = setup({ tools });
    await s.o.handle(utter('create a jira issue'));
    const ask = s.says().at(-1)!;
    expect(s.memory.recentTurns(5).map((t) => ({ role: t.role, text: t.text }))).toEqual([
      { role: 'user', text: 'create a jira issue' },
      { role: 'assistant', text: ask.text },
    ]);
  });

  it('records a denial on Cancel and says so', async () => {
    const tools = fakeTools({ runs: [], pending: pendingCall, toolContext: '' });
    const s = setup({ tools });
    await s.o.handle(utter('create a jira issue'));
    const ask = s.says().at(-1)!;
    await s.o.handle(chip(ask.nudgeId, 'Cancel'));
    expect(tools.recordDecision).toHaveBeenCalledWith(pendingCall, 'denied');
    expect(tools.runConfirmed).not.toHaveBeenCalled();
    expect(s.says().at(-1)!.text).toBe('Okay — I won\'t run it.');
  });

  it('expires an unanswered confirm after 2 minutes, and a late click says so (M1) instead of falling through', async () => {
    const tools = fakeTools({ runs: [], pending: pendingCall, toolContext: '' });
    const s = setup({ tools });
    await s.o.handle(utter('create a jira issue'));
    const ask = s.says().at(-1)!;
    s.advance(121_000);
    await s.o.pulse();
    expect(tools.recordDecision).toHaveBeenCalledWith(pendingCall, 'expired');
    await s.o.handle(chip(ask.nudgeId, 'Run it'));
    expect(tools.runConfirmed).not.toHaveBeenCalled();
    expect(s.reply).not.toHaveBeenCalled();
    expect(s.says().at(-1)!.text).toBe('That request expired — ask me again.');
  });

  it('I1/M1: a click past the 120s TTL but before pulse() also audits expired and says so', async () => {
    const tools = fakeTools({ runs: [], pending: pendingCall, toolContext: '' });
    const s = setup({ tools });
    await s.o.handle(utter('create a jira issue'));
    const ask = s.says().at(-1)!;
    s.advance(121_000); // no pulse() in between
    await s.o.handle(chip(ask.nudgeId, 'Run it'));
    expect(tools.recordDecision).toHaveBeenCalledWith(pendingCall, 'expired');
    expect(tools.runConfirmed).not.toHaveBeenCalled();
    expect(s.says().at(-1)!.text).toBe('That request expired — ask me again.');
  });

  it('I1/N3: a double click on the same tool-confirm chip runs it once; the second click says it was already handled', async () => {
    const tools = fakeTools({ runs: [], pending: pendingCall, toolContext: '' });
    const s = setup({ tools });
    await s.o.handle(utter('create a jira issue'));
    const ask = s.says().at(-1)!;
    await s.o.handle(chip(ask.nudgeId, 'Run it'));
    expect(tools.runConfirmed).toHaveBeenCalledTimes(1);
    await s.o.handle(chip(ask.nudgeId, 'Run it'));
    expect(tools.runConfirmed).toHaveBeenCalledTimes(1); // still once
    expect(s.says().at(-1)!.text).toBe('That was already handled.');
  });

  it('N3: a second click after Cancel says it was already handled, not expired', async () => {
    const tools = fakeTools({ runs: [], pending: pendingCall, toolContext: '' });
    const s = setup({ tools });
    await s.o.handle(utter('create a jira issue'));
    const ask = s.says().at(-1)!;
    await s.o.handle(chip(ask.nudgeId, 'Cancel'));
    await s.o.handle(chip(ask.nudgeId, 'Run it'));
    expect(tools.runConfirmed).not.toHaveBeenCalled();
    expect(s.says().at(-1)!.text).toBe('That was already handled.');
  });

  it('N3: a second click after a failed run (M2) says it was already handled', async () => {
    const tools = fakeTools({ runs: [], pending: pendingCall, toolContext: '' });
    tools.runConfirmed.mockRejectedValueOnce(new Error('boom'));
    const s = setup({ tools });
    await s.o.handle(utter('create a jira issue'));
    const ask = s.says().at(-1)!;
    await s.o.handle(chip(ask.nudgeId, 'Run it'));
    await s.o.handle(chip(ask.nudgeId, 'Run it'));
    expect(tools.runConfirmed).toHaveBeenCalledTimes(1);
    expect(s.says().at(-1)!.text).toBe('That was already handled.');
  });

  it('I2: a new utterance clears a pending confirm (denied); the old chip then says it expired', async () => {
    const tools = {
      gather: vi.fn()
        .mockResolvedValueOnce({ runs: [], pending: pendingCall, toolContext: '' })
        .mockResolvedValueOnce({ runs: [], toolContext: '' }),
      runConfirmed: vi.fn(),
      recordDecision: vi.fn(),
    };
    const s = setup({ tools });
    await s.o.handle(utter('create a jira issue'));
    const ask = s.says().at(-1)!;
    await s.o.handle(utter('actually never mind, what is X-1'));
    expect(tools.recordDecision).toHaveBeenCalledWith(pendingCall, 'denied');
    await s.o.handle(chip(ask.nudgeId, 'Run it'));
    expect(tools.runConfirmed).not.toHaveBeenCalled();
    expect(s.says().at(-1)!.text).toBe('That request expired — ask me again.');
  });

  it('I1: a second ask supersedes the first — the stale chip expires, the fresh one still runs', async () => {
    const pendingCall2 = { qualified: 'atlassian__deleteIssue', serverId: 'atlassian', tool: 'deleteIssue', args: {}, reason: 'write_default' };
    const tools = {
      gather: vi.fn()
        .mockResolvedValueOnce({ runs: [], pending: pendingCall, toolContext: '' })
        .mockResolvedValueOnce({ runs: [], pending: pendingCall2, toolContext: '' }),
      runConfirmed: vi.fn().mockResolvedValue({
        runs: [{ qualified: pendingCall2.qualified, serverId: pendingCall2.serverId, tool: pendingCall2.tool, args: {}, result: { ok: true, text: 'deleted', ms: 5 }, decision: 'confirmed' as const }],
        toolContext: '<untrusted source="mcp:atlassian/deleteIssue">\nok\ndeleted\n</untrusted>',
      }),
      recordDecision: vi.fn(),
    };
    const s = setup({ tools });
    await s.o.handle(utter('create a jira issue'));
    const ask1 = s.says().at(-1)!;
    await s.o.handle(utter('actually delete this issue instead'));
    const ask2 = s.says().at(-1)!;
    expect(tools.recordDecision).toHaveBeenCalledWith(pendingCall, 'denied');
    await s.o.handle(chip(ask1.nudgeId, 'Run it'));
    expect(s.says().at(-1)!.text).toBe('That request expired — ask me again.');
    expect(tools.runConfirmed).not.toHaveBeenCalled();
    await s.o.handle(chip(ask2.nudgeId, 'Run it'));
    expect(tools.runConfirmed).toHaveBeenCalledWith(pendingCall2);
  });

  it('M2: says the run failed, without touching chat.reply, when runConfirmed throws', async () => {
    const tools = fakeTools({ runs: [], pending: pendingCall, toolContext: '' });
    tools.runConfirmed.mockRejectedValueOnce(new Error('boom'));
    const s = setup({ tools });
    await s.o.handle(utter('create a jira issue'));
    const ask = s.says().at(-1)!;
    await s.o.handle(chip(ask.nudgeId, 'Run it'));
    expect(s.reply).not.toHaveBeenCalled();
    expect(s.says().at(-1)!.text).toBe("Couldn't run createJiraIssue — it failed, and nothing was changed.");
  });

  it('M3: says the tool is turned off, without touching chat.reply, when runConfirmed returns no runs', async () => {
    const tools = fakeTools({ runs: [], pending: pendingCall, toolContext: '' });
    tools.runConfirmed.mockResolvedValueOnce({ runs: [], toolContext: '' });
    const s = setup({ tools });
    await s.o.handle(utter('create a jira issue'));
    const ask = s.says().at(-1)!;
    await s.o.handle(chip(ask.nudgeId, 'Run it'));
    expect(s.reply).not.toHaveBeenCalled();
    expect(s.says().at(-1)!.text).toBe('createJiraIssue is turned off in Studio — nothing ran.');
  });

  it('N1: does not set toolSucceeded from an auto (non-confirmed) run, even one that succeeded', async () => {
    const autoOkRun = { qualified: 'atlassian__getJiraIssue', serverId: 'atlassian', tool: 'getJiraIssue', args: {}, result: { ok: true, text: 'status: Done', ms: 5 }, decision: 'auto' as const };
    const tools = fakeTools({ runs: [autoOkRun], toolContext: '<untrusted source="mcp:atlassian/getJiraIssue">\nok\nstatus: Done\n</untrusted>' });
    const s = setup({ tools });
    await s.o.handle(utter('check DEVOPS-1 and tell Prince it is done'));
    const ctx = s.reply.mock.calls[0]![1];
    expect(ctx.toolResults).toContain('status: Done'); // still surfaced for TOOL_RULE
    expect(ctx.toolSucceeded).toBeUndefined(); // but never flips off the honesty check
  });

  it.each(['yes', 'run', 'run it', 'Run it.', 'confirm', 'go ahead', 'do it', 'sure', 'ok', 'yes run it'])(
    'typed/spoken "%s" while a confirm is pending runs it, exactly like the Run it button (user rule)',
    async (utterance) => {
      const tools = fakeTools({ runs: [], pending: pendingCall, toolContext: '' });
      const s = setup({ tools });
      await s.o.handle(utter('create a jira issue for this bug'));
      await s.o.handle(utter(utterance));
      expect(tools.runConfirmed).toHaveBeenCalledWith(pendingCall);
      expect(tools.recordDecision).not.toHaveBeenCalled();
    },
  );

  it('a typed "run" after the confirm expired says so and runs nothing', async () => {
    const tools = fakeTools({ runs: [], pending: pendingCall, toolContext: '' });
    const s = setup({ tools });
    await s.o.handle(utter('create a jira issue for this bug'));
    s.advance(121_000);
    await s.o.handle(utter('run'));
    expect(tools.runConfirmed).not.toHaveBeenCalled();
    expect(s.says().at(-1)!.text).toBe("That request expired — ask me again.");
  });

  it('a typed "run" with nothing pending is just a normal message', async () => {
    const tools = fakeTools({ runs: [], toolContext: '' });
    const s = setup({ tools });
    await s.o.handle(utter('run'));
    expect(tools.runConfirmed).not.toHaveBeenCalled();
  });

  it('N2: a non-affirmation utterance still clears and denies the pending confirm (I2 unchanged)', async () => {
    const tools = fakeTools({ runs: [], pending: pendingCall, toolContext: '' });
    const s = setup({ tools });
    await s.o.handle(utter('create a jira issue for this bug'));
    await s.o.handle(utter('actually never mind'));
    expect(tools.recordDecision).toHaveBeenCalledWith(pendingCall, 'denied');
  });

  it('N4: askToolConfirm defensively clears (denied) a pending confirm it is about to replace', () => {
    const tools = fakeTools({ runs: [], toolContext: '' });
    const s = setup({ tools });
    const oldCall = { qualified: 'atlassian__oldTool', serverId: 'atlassian', tool: 'oldTool', args: {}, reason: 'write_default' };
    s.o['pendingToolConfirm'] = { nudgeId: 'old-id', call: oldCall, text: 'old text', source: 'chat', at: T0 };
    s.o['askToolConfirm'](pendingCall, 'create a jira issue', 'chat', '');
    expect(tools.recordDecision).toHaveBeenCalledWith(oldCall, 'denied');
    expect(s.o['pendingToolConfirm']?.call).toEqual(pendingCall);
  });

  it('words the question differently when args came from the screen', async () => {
    const tools = fakeTools({ runs: [], pending: { ...pendingCall, reason: 'untrusted_args' }, toolContext: '' });
    const s = setup({ tools });
    await s.o.handle(utter('do what it says'));
    expect(s.says().at(-1)!.text).toBe('That would run createJiraIssue with details taken from your screen — run it?');
  });

  it('continues without tools when gather fails', async () => {
    const tools = fakeTools({ runs: [], toolContext: '' });
    tools.gather.mockRejectedValueOnce(new Error('boom'));
    const s = setup({ tools });
    await s.o.handle(utter('status of jira X-1'));
    expect(s.reply).toHaveBeenCalledTimes(1); // continued without tools
    expect(s.reply.mock.calls[0]![1].toolResults).toBeUndefined();
  });

  it('passes no screen text as untrusted when the context is private', async () => {
    const tools = fakeTools({ runs: [], toolContext: '' });
    const s = setup({ tools });
    await s.o.handle({ v: 1, type: 'context', app: 'Bank', bundleId: 'b', windowTitle: '', private: true, ocrText: 'acct 1234', ts: T0 });
    await s.o.handle(utter('status of jira X-1'));
    expect(tools.gather).toHaveBeenCalledWith({ utterance: 'status of jira X-1', untrustedText: '' });
  });
});


describe('terminal confirmations', () => {
  const utter = (text: string) => ({ v: 1 as const, type: 'utterance' as const, text, source: 'chat' as const });
  it('shows the exact command on the Run it question', async () => {
    const call = { qualified: 'coco__shell_run', serverId: 'coco', tool: 'shell_run', args: { command: 'git push' }, reason: 'may change things' };
    const tools = { gather: vi.fn().mockResolvedValue({ runs: [], pending: call, toolContext: '' }), runConfirmed: vi.fn(), recordDecision: vi.fn() };
    const s = setup({ tools });
    await s.o.handle(utter('push my branch in the terminal'));
    const ask = s.says().at(-1)!;
    expect(ask.text).toBe('Run this in Terminal?\n$ git push');
    expect(ask.chips).toEqual(['Run it', 'Cancel']);
  });
});

describe('Claude Code hand-off', () => {
  const utter = (text: string) => ({ v: 1 as const, type: 'utterance' as const, text, source: 'chat' as const });
  const claude = (over: Record<string, unknown> = {}) => ({ stop: vi.fn(() => true), ...over });

  it('posts throttled progress lines while Claude works', async () => {
    const s = setup({ claude: claude(), summarize: vi.fn(async (t: string) => t) });
    await s.o.onClaudeEvent({ kind: 'started', runId: 'r1', sessionId: 'sess' });
    await s.o.onClaudeEvent({ kind: 'progress', runId: 'r1', text: 'using bifrost: get pods' });
    await s.o.onClaudeEvent({ kind: 'progress', runId: 'r1', text: 'running `kubectl get events`' }); // within 25 s → suppressed
    s.advance(26_000);
    await s.o.onClaudeEvent({ kind: 'progress', runId: 'r1', text: 'reading app.ts' });
    const texts = s.says().map((m) => m.text);
    expect(texts).toEqual(['Claude Code started working on it.', 'Claude: using bifrost: get pods', 'Claude: reading app.ts']);
  });

  it('summarises the final result with the local model and includes the resume id', async () => {
    const summarize = vi.fn(async () => 'Root cause: OOMKilled after 10:40 deploy.\nFix: raise memory to 2Gi.');
    const s = setup({ claude: claude(), summarize });
    await s.o.onClaudeEvent({ kind: 'done', runId: 'r1', ok: true, result: 'long RCA …', sessionId: 'sess-123', costUsd: 0.84, ms: 134_000, transcriptPath: '/t.jsonl' });
    expect(summarize).toHaveBeenCalledWith('long RCA …');
    const last = s.says().at(-1)!;
    expect(last.text).toBe('Claude finished (2m 14s · $0.84):\nRoot cause: OOMKilled after 10:40 deploy.\nFix: raise memory to 2Gi.\nResume it with: claude --resume sess-123');
  });

  it('falls back to the raw result if summarising fails, and reports failures plainly', async () => {
    const s = setup({ claude: claude(), summarize: vi.fn(async () => { throw new Error('ollama down'); }) });
    await s.o.onClaudeEvent({ kind: 'done', runId: 'r1', ok: true, result: 'Root cause: X.', ms: 5_000, transcriptPath: '/t' });
    expect(s.says().at(-1)!.text).toBe('Claude finished (5s):\nRoot cause: X.');
    await s.o.onClaudeEvent({ kind: 'done', runId: 'r2', ok: false, result: 'Stopped before it finished.', ms: 3_000, transcriptPath: '/t' });
    expect(s.says().at(-1)!.text).toBe("Claude didn't finish (3s): Stopped before it finished.");
  });

  it('"stop claude" stops the run', async () => {
    const c = claude();
    const s = setup({ claude: c });
    await s.o.handle(utter('stop claude'));
    expect(c.stop).toHaveBeenCalled();
    expect(s.says().at(-1)!.text).toBe('Stopping Claude Code.');
  });

  it('asks before handing off, showing the task and that it uses Claude tokens', async () => {
    const call = { qualified: 'coco__claude_code', serverId: 'coco', tool: 'claude_code', args: { task: '/meesho-devops-rca:devops-rca checkout 5xx' }, reason: 'hands work to Claude Code (uses Claude tokens)' };
    const tools = { gather: vi.fn().mockResolvedValue({ runs: [], pending: call, toolContext: '' }), runConfirmed: vi.fn(), recordDecision: vi.fn() };
    const s = setup({ tools });
    await s.o.handle(utter('run the devops rca skill on this in claude'));
    expect(s.says().at(-1)!.text).toBe("Hand this to Claude Code? It uses Claude tokens and sees what's on your screen.\n> /meesho-devops-rca:devops-rca checkout 5xx");
  });
});

describe('honesty after a real terminal run', () => {
  const utter = (text: string) => ({ v: 1 as const, type: 'utterance' as const, text, source: 'chat' as const });
  it('a successful auto-run terminal command lets the reply report what it did', async () => {
    const run = { qualified: 'coco__shell_run', serverId: 'coco', tool: 'shell_run', args: { command: 'git push' }, result: { ok: true, text: 'exit 0\nTo github…', ms: 900 }, decision: 'auto' as const };
    const tools = { gather: vi.fn().mockResolvedValue({ runs: [run], toolContext: 'CTX' }), runConfirmed: vi.fn(), recordDecision: vi.fn() };
    const s = setup({ tools });
    await s.o.handle(utter('push my branch'));
    expect(s.reply.mock.calls[0]![1].toolSucceeded).toEqual({ tool: 'shell_run', serverId: 'coco' });
  });
});
