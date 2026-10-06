import type { GatherResult, PendingToolCall, ToolLoop, ToolRun } from './agent/loop.js';
import { CLAUDE_QUALIFIED, type ClaudeEvent } from './agent/claudeCode.js';
import { SHELL_QUALIFIED } from './agent/shell.js';
import type { ChatContext, ChatReply } from './chat.js';
import type { Command } from './commands.js';
import { parseCommand } from './commands.js';
import { detectFocusOffer, isAffirmation } from './offers.js';
import type { CocoConfig } from './config.js';
import { isIncident } from './context/incident.js';
import type { LookPolicy } from './context/look.js';
import type { Timeline } from './context/timeline.js';
import { detectTrigger, type Trigger, type TriggerDeduper } from './context/triggers.js';
import type { Logger } from './logger.js';
import type { Memory, NudgeOutcome } from './memory.js';
import { ModelUnavailableError, PRIORITY, type ModelGateway, type Priority } from './model/gateway.js';
import { MUTE_MS, nextLocalMidnight, type NudgePolicy } from './nudge/policy.js';
import type { NudgeDecision } from './persona/decision.js';
import type { DecideInput } from './persona/decider.js';
import type { ModelAction } from './persona/actions.js';
import { claimsPendingAction } from './persona/selfcheck.js';
import { isKnownSiteResult } from './sites.js';
import { noopTrace, type DecisionTrace } from './trace.js';
import type {
  ActivityState,
  BodyToBrain,
  BrainToBody,
  ContextMsg,
  FocusResultMsg,
  KeyframeMsg,
  Mood,
  OpenUrlResultMsg,
  PasteResultMsg,
  SayKind,
} from './protocol.js';

export interface OrchestratorDeps {
  send: (msg: BrainToBody) => void;
  clock: () => number;
  newId: () => string;
  config: CocoConfig;
  timeline: Timeline;
  look: LookPolicy;
  policy: NudgePolicy;
  triggers: TriggerDeduper;
  decider: { decide(input: DecideInput, priority: Priority): Promise<NudgeDecision | null> };
  chat: { reply(text: string, ctx: ChatContext): Promise<ChatReply> };
  memory: Memory;
  gateway: Pick<ModelGateway, 'health'>;
  keyframesEnabled: boolean;
  log: Logger;
  /** Opt-in decision trace (see trace.ts, config debug.trace). Defaults to a no-op. */
  trace?: DecisionTrace;
  /** Optional connector tool loop (agent/loop.ts) — omitted, every existing caller/test keeps working with no tools offered. */
  tools?: Pick<ToolLoop, 'gather' | 'runConfirmed' | 'recordDecision'>;
  /** Optional Claude Code hand-off (agent/claudeCode.ts) — only `stop` is needed here; events arrive via onClaudeEvent. */
  claude?: { stop(): boolean };
  /** Turns a long Claude result into a short summary (the local model). Falls back to the raw text when it fails. */
  summarize?: (text: string) => Promise<string>;
}

export const TOOL_RUN_CHIP = 'Run it';
export const TOOL_CANCEL_CHIP = 'Cancel';
export const TOOL_CONFIRM_TTL_MS = 120_000;
/** I1: how long a spent/expired/superseded tool-confirm nudgeId is remembered, so a stale click on that
 * exact bubble gets an honest reply instead of falling through to a generic chat turn with no tool result. */
const CONSUMED_TOOL_CONFIRM_TTL_MS = 10 * 60_000;
/** N3: only a truly expired or replaced id gets this — a click that was actually acted on (run, denied,
 * or superseded by clicking through) gets TOOL_CONFIRM_HANDLED_TEXT instead. */
const TOOL_CONFIRM_EXPIRED_TEXT = 'That request expired — ask me again.';
/** N3: a second click on a chip whose confirm was already run, failed, turned off, or cancelled. */
const TOOL_CONFIRM_HANDLED_TEXT = 'That was already handled.';
/** N2: a spoken/typed "yes" to a pending write confirm is not a click — only the button runs it. */
/** N2: beyond offers.ts's general isAffirmation ("sure", "yes", "go ahead", "do it", …), a tool-confirm
 * specifically also accepts "run it" and "confirm" — the chip's own label and the obvious synonym. */
const TOOL_CONFIRM_AFFIRMATION = /^(?:(?:yes|yeah|yep|ok|okay|sure|please|go|go ahead|do it|run|run it|confirm|execute|proceed)[\s,.!]*)+$/i;

interface PendingNudge {
  id: string;
  at: number;
}

interface PendingTrigger {
  trigger: Trigger;
  contextKey: string;
  at: number;
}

/** Where the in-flight utterance/command came from: the Swift body's on-device STT ('voice') or typed chat ('chat'). */
type Source = 'voice' | 'chat';

interface PendingFocus {
  requestId: string;
  target: string;
  kind: 'app' | 'window';
  source: Source;
  at: number;
  /** The decision-trace turnId that sent this focus, or '' when there isn't one (e.g. a chip-derived
   * confirm). */
  turnId: string;
}

interface PendingOpen {
  requestId: string;
  label: string;
  source: Source;
  at: number;
  /** The decision-trace turnId that sent this open, or '' when there isn't one. */
  turnId: string;
}

interface PendingOffer {
  target: string;
  kind: 'app';
  at: number;
}

/** M7: a model-proposed url that isn't a known-site homepage/search result — Coco asked before opening it,
 * via a "Open <host>" chip on the say that carries `nudgeId`. */
interface PendingUrlConfirm {
  nudgeId: string;
  url: string;
  label: string;
  host: string;
  at: number;
}

/** The most recent draft Coco offered to paste, from the say ("id") that carried it. */
interface PendingDraft {
  id: string;
  text: string;
  app: string;
  at: number;
}

interface PendingPaste {
  requestId: string;
  app: string;
  source: Source;
  at: number;
  /** The decision-trace turnId that sent this paste, or '' when there isn't one (e.g. a "paste into <App>" chip). */
  turnId: string;
}

const KEYFRAME_FRESH_MS = 60_000;
const OFFER_TTL_MS = 120_000;
/** I5: a cold app launch (Xcode, Docker Desktop, a many-profile Chrome) regularly takes well over 5s —
 * the original timeout reported failure for launches that were still succeeding. 20s for both; simplest
 * to keep them equal rather than distinguish "focus of an already-running app" as a separate, shorter case. */
const FOCUS_TIMEOUT_MS = 20_000;
const OPEN_TIMEOUT_MS = 20_000;
/** M7: how long an "Open <host>" confirm chip stays live — matches OFFER_TTL_MS's 2 minutes. */
const URL_CONFIRM_TTL_MS = 120_000;
const DRAFT_TTL_MS = 10 * 60_000;
const PASTE_TIMEOUT_MS = 5000;
/** "paste", "paste it", "paste that", "paste the draft", "paste into <App>" — the only utterances that trigger a paste. */
const PASTE_UTTERANCE = /^(paste( it| that| the draft)?|paste into \w+)[.! ]*$/i;
const MUTED_STATE_KEY = 'mutedUntil';
const RECENT_TEXTS = 20;
const PENDING_TRIGGER_TTL_MS = 10 * 60_000;
const HEALTH_BACKOFF_START_MS = 15_000;
const HEALTH_BACKOFF_MAX_MS = 120_000;
const CONTEXT_LOG_OCR_DELTA = 50;
const SHH = 'shh';
const SHH_TODAY = 'shh for today';
const UNMUTE = 'unmute';
const DISMISS = 'dismiss';
const CLEAR_CHAT = 'clear chat';
const STOP_CLAUDE = /^(stop|cancel) (claude|claude code)[.!]*$/;
const CLAUDE_PROGRESS_GAP_MS = 25_000;
const CLAUDE_MAX_PROGRESS = 6;
const FORGET_CHAT = 'forget this chat';
const TEXT = {
  muted30: "Muted for 30 minutes. I'll still answer if you ask.",
  mutedToday: "Muted until tomorrow. I'll still answer if you ask.",
  unmuted: "Unmuted. I'll speak up when something's worth it.",
  offline: "Brain offline: Ollama isn't answering. I'll keep checking.",
  online: "I'm back. Brain's online.",
  offlineReply: "My brain's offline right now (Ollama isn't answering). I'll be back when it is.",
  genericError: "Something broke on my side. It's in the brain log.",
  chatCleared: 'Chat cleared. Fresh start.',
} as const;

const BUSY: ReadonlySet<ActivityState> = new Set(['typing', 'in_call', 'sharing']);

const withShh = (chips: readonly string[]): string[] => [
  ...chips.filter((c) => c.trim().toLowerCase() !== SHH).slice(0, 3),
  SHH,
];

/** M7: the host to show in an "Open <host>" confirm chip. `url` is already known-valid http(s) (extractAction
 * checked), so this only ever returns undefined defensively. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** I3/N1: the CONFIRMED tool run (if any) this turn actually completed with `result.ok === true` — the
 * last one, since that's most relevant to what the user just asked. Feeds ChatContext.toolSucceeded, which
 * lets the reply honestly report a real WRITE instead of being flattened by the unperformed-action honesty
 * check. N1: never an `auto` run — a read-only lookup completed nothing a completion claim could refer to,
 * so treating it as "success" here would switch the honesty check off on the most common tool turn. */
function lastSuccessfulRun(runs: readonly ToolRun[]): { tool: string; serverId: string } | undefined {
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!;
    // A terminal command really did something even when it ran without a click (user rule: only deletes ask), so
    // a reply reporting it ("pushed your branch") is honest; a connector lookup that auto-ran is not.
    if ((run.decision === 'confirmed' || run.qualified === SHELL_QUALIFIED) && run.result.ok) return { tool: run.tool, serverId: run.serverId };
  }
  return undefined;
}

export class Orchestrator {
  private activity: ActivityState = 'reading';
  private keyframe: { key: string; jpeg: string; ts: number } | undefined;
  private pending: readonly PendingNudge[] = [];
  private pendingTrigger: PendingTrigger | undefined;
  private pendingFocus: PendingFocus | undefined;
  private pendingOpen: PendingOpen | undefined;
  private pendingUrlConfirm: PendingUrlConfirm | undefined;
  /** A "bring X to the front" offer Coco just made; a bare "sure" within OFFER_TTL_MS accepts it. */
  private pendingOffer: PendingOffer | undefined;
  /** The most recent draft Coco offered to paste (non-private context only); stale after DRAFT_TTL_MS. */
  private lastDraft: PendingDraft | undefined;
  private pendingPaste: PendingPaste | undefined;
  /** A tool call awaiting a "Run it"/"Cancel" chip click, keyed to the say's nudgeId. Security note: the
   * pending call lives only here, in the Brain — the chip message the Body echoes back carries only
   * nudgeId + choice text, never call data (see handleToolChip). */
  private pendingToolConfirm?: { nudgeId: string; call: PendingToolCall; text: string; source: Source; at: number };
  /** I1/N3: nudgeIds of tool confirms already resolved, each remembered for CONSUMED_TOOL_CONFIRM_TTL_MS —
   * 'handled' for one a button click actually acted on (run, denied, or turned-off/failed), 'expired' for
   * one that timed out or was replaced by a newer ask — see markToolConfirmConsumed/consumedToolConfirmReason. */
  private readonly consumedToolConfirms = new Map<string, { at: number; reason: 'handled' | 'expired' }>();
  private recentTexts: ReadonlyMap<string, string> = new Map();
  private deciding = false;
  private mood: Mood | undefined;
  private online = true;
  /** True while offline and no successful model call has announced recovery yet. */
  private awaitingRecovery = false;
  private healthBackoffMs = 0;
  private nextHealthCheckAt = 0;
  private lastContextLog: { app: string; bundleId: string; ocrChars: number } | undefined;
  private readonly trace: DecisionTrace;

  constructor(private readonly d: OrchestratorDeps) {
    this.trace = d.trace ?? noopTrace;
    const mutedUntil = d.memory.getState<number>(MUTED_STATE_KEY);
    if (typeof mutedUntil === 'number') d.policy.muteUntil(mutedUntil);
  }

  async handle(msg: BodyToBrain): Promise<void> {
    switch (msg.type) {
      case 'context':
        return this.onContext(msg);
      case 'activity':
        this.activity = msg.state;
        this.updateMood();
        return;
      case 'keyframe':
        return this.onKeyframe(msg);
      case 'utterance':
        return this.onUtterance(msg.text, msg.source);
      case 'chip':
        return this.onChip(msg.nudgeId, msg.choice);
      case 'focus_result':
        return this.onFocusResult(msg);
      case 'paste_result':
        return this.onPasteResult(msg);
      case 'open_url_result':
        return this.onOpenUrlResult(msg);
    }
  }

  private claudeProgress = { lastAt: -Infinity, count: 0 };

  /** Progress + final answer from a background Claude Code run (agent/claudeCode.ts). */
  async onClaudeEvent(e: ClaudeEvent): Promise<void> {
    const now = this.d.clock();
    if (e.kind === 'started') {
      this.claudeProgress = { lastAt: now, count: 0 };
      this.say('Claude Code started working on it.', 'status', { speak: false });
      return;
    }
    if (e.kind === 'progress') {
      if (now - this.claudeProgress.lastAt < CLAUDE_PROGRESS_GAP_MS && this.claudeProgress.count > 0) return;
      if (this.claudeProgress.count >= CLAUDE_MAX_PROGRESS) return;
      this.claudeProgress = { lastAt: now, count: this.claudeProgress.count + 1 };
      this.say(`Claude: ${e.text.slice(0, 140)}`, 'status', { speak: false });
      return;
    }
    const took = formatDuration(e.ms) + (e.costUsd !== undefined ? ` · $${e.costUsd.toFixed(2)}` : '');
    if (!e.ok) {
      this.say(`Claude didn't finish (${took}): ${e.result.slice(0, 300)}`, 'reply', { speak: this.d.config.voice.enabled && this.d.config.voice.speakNudges });
      return;
    }
    let summary = e.result;
    try {
      if (this.d.summarize) summary = (await this.d.summarize(e.result)).trim() || e.result;
    } catch {
      this.d.log.warn('claude_summary_failed');
    }
    const resume = e.sessionId ? `\nResume it with: claude --resume ${e.sessionId}` : '';
    const text = `Claude finished (${took}):\n${summary.slice(0, 1500)}${resume}`;
    this.say(text, 'reply', { speak: this.d.config.voice.enabled && this.d.config.voice.speakNudges });
    this.d.memory.addTurn('assistant', text, now);
  }

  onBodyConnected(): void {
    this.mood = undefined;
    this.updateMood();
  }

  /** Returns a promise so callers can await the pending-trigger retry; the synchronous work (expiry, keyframe request) always runs immediately. */
  pulse(): Promise<void> {
    const now = this.d.clock();
    this.expirePending(now);
    this.expirePendingFocus(now);
    this.expirePendingOpen(now);
    this.expirePendingPaste(now);
    this.expirePendingToolConfirm(now);
    this.clearStalePendingTrigger(now);
    this.maybeRequestKeyframe(now);
    this.trace.sweep(now);
    return this.retryPendingTrigger();
  }

  async tick(): Promise<void> {
    await this.maybeNudge(null, PRIORITY.tick);
  }

  async checkHealth(): Promise<void> {
    const now = this.d.clock();
    if (!this.online && now < this.nextHealthCheckAt) return; // still backing off
    const healthy = await this.d.gateway.health();
    if (healthy) {
      this.healthBackoffMs = 0;
      this.nextHealthCheckAt = 0;
      this.clearOfflineGating();
    } else {
      this.healthBackoffMs = this.healthBackoffMs === 0 ? HEALTH_BACKOFF_START_MS : Math.min(this.healthBackoffMs * 2, HEALTH_BACKOFF_MAX_MS);
      this.nextHealthCheckAt = now + this.healthBackoffMs;
      this.goOffline();
    }
  }

  // ---- inputs -------------------------------------------------------------

  private async onContext(msg: ContextMsg): Promise<void> {
    this.d.timeline.ingest(msg);
    this.updateMood();
    this.logContextIn(msg);
    if (msg.private) return;
    const now = this.d.clock();
    const key = this.d.timeline.contextKey();
    if (this.pendingTrigger && this.pendingTrigger.contextKey !== key) this.pendingTrigger = undefined;
    this.maybeRequestKeyframe(now);
    const trigger = detectTrigger(msg, this.d.config.user.handles);
    if (trigger && this.d.triggers.isNew(trigger, now)) {
      const attempted = await this.maybeNudge(trigger, PRIORITY.trigger);
      if (attempted) {
        this.d.triggers.mark(trigger, now);
        this.pendingTrigger = undefined;
      } else if (key) {
        this.pendingTrigger = { trigger, contextKey: key, at: now };
      }
    }
  }

  /** Diagnostics only (counts/ids, never OCR text/title/URL content): logs on app/bundleId change or a >50-char ocrChars swing, to avoid 1/s spam. */
  private logContextIn(msg: ContextMsg): void {
    const ocrChars = msg.ocrText?.length ?? 0;
    const prev = this.lastContextLog;
    const changed = !prev || prev.app !== msg.app || prev.bundleId !== msg.bundleId || Math.abs(ocrChars - prev.ocrChars) > CONTEXT_LOG_OCR_DELTA;
    if (!changed) return;
    this.lastContextLog = { app: msg.app, bundleId: msg.bundleId, ocrChars };
    this.d.log.info('context_in', {
      app: msg.app,
      bundleId: msg.bundleId,
      private: msg.private,
      titleChars: msg.windowTitle.length,
      urlPresent: msg.url !== undefined,
      selectionChars: msg.selection?.length ?? 0,
      ocrChars,
    });
  }

  private async onKeyframe(msg: KeyframeMsg): Promise<void> {
    const key = this.d.timeline.contextKey();
    if (!key) return;
    this.keyframe = { key, jpeg: msg.jpegBase64, ts: this.d.clock() };
    await this.maybeNudge(null, PRIORITY.tick);
  }

  private async onUtterance(text: string, source: Source): Promise<void> {
    const now = this.d.clock();
    const turnId = this.trace.startTurn({ source, text });
    // User rule (2026-10-06): a typed or spoken "run"/"yes"/"go ahead" while a confirm is pending is the same
    // as clicking Run it — it goes through the chip handler, so expiry, auditing and the result reply are
    // identical. Only the user's own utterance can do this; screen text and chips from other bubbles cannot.
    if (this.pendingToolConfirm && this.isToolConfirmAffirmation(text)) {
      this.trace.finishTurn(turnId);
      await this.handleToolChip(this.pendingToolConfirm.nudgeId, TOOL_RUN_CHIP);
      return;
    }
    // I2: any other new utterance means the user has moved on from a still-armed write confirm — disarm it
    // and audit the spoken cancel as 'denied', rather than leaving it runnable off a stale chip for up to 120s.
    this.clearPendingToolConfirm('denied');
    this.resolveAll('engaged');
    const offer = this.takeOffer(now);
    if (offer && isAffirmation(text)) {
      this.trace.setRoute(turnId, { via: 'offer' });
      return this.startFocus({ type: 'focus', target: offer.target, kind: offer.kind }, text, now, source, true, turnId);
    }
    if (PASTE_UTTERANCE.test(text.trim())) {
      this.trace.setRoute(turnId, { via: 'paste' });
      return this.triggerPaste(now, source, turnId);
    }
    const command = text.trim().toLowerCase();
    if (command === SHH) {
      this.trace.setRoute(turnId, { via: 'mute' });
      return this.mute(now + MUTE_MS, TEXT.muted30, turnId);
    }
    if (command === SHH_TODAY) {
      this.trace.setRoute(turnId, { via: 'mute' });
      return this.mute(nextLocalMidnight(now), TEXT.mutedToday, turnId);
    }
    if (command === UNMUTE) {
      this.trace.setRoute(turnId, { via: 'mute' });
      return this.mute(now, TEXT.unmuted, turnId);
    }
    if (this.d.claude && STOP_CLAUDE.test(command)) {
      this.trace.setRoute(turnId, { via: 'clear' });
      this.sayTraced(this.d.claude.stop() ? 'Stopping Claude Code.' : "Claude Code isn't running anything.", 'reply', turnId);
      return;
    }
    if (command === CLEAR_CHAT || command === FORGET_CHAT) {
      this.trace.setRoute(turnId, { via: 'clear' });
      this.d.memory.clearTurns();
      this.sayTraced(TEXT.chatCleared, 'reply', turnId);
      return;
    }
    const cmd = parseCommand(text);
    if (cmd) {
      this.trace.setRoute(turnId, { via: 'command', command: cmd });
      return cmd.type === 'open_url'
        ? this.startOpenUrl(cmd, text, now, source, true, turnId)
        : this.startFocus(cmd, text, now, source, true, turnId);
    }
    this.trace.setRoute(turnId, { via: 'model' });
    // C1: intentText is the user's own words for THIS turn — the only thing a model-proposed action may
    // ever be gated on. Never pass anything else here (see onChip, which passes undefined).
    await this.answer(text, source, text, turnId);
  }

  /** Returns the live pending offer (if any) and clears it: any user message consumes or cancels the offer. */
  private takeOffer(now: number): PendingOffer | undefined {
    const offer = this.pendingOffer;
    this.pendingOffer = undefined;
    return offer && now - offer.at < OFFER_TTL_MS ? offer : undefined;
  }

  /** Remembers (or forgets) a focus offer in the latest nudge or chat reply Coco just sent. */
  private rememberOffer(text: string): void {
    const target = detectFocusOffer(text);
    this.pendingOffer = target ? { target, kind: 'app', at: this.d.clock() } : undefined;
  }

  /** M4: `send` validates against the protocol schema and throws on a mismatch (e.g. an overlong target) —
   * this must happen BEFORE any pending state is set, or a failed send still leaves a dangling
   * pendingFocus/pendingOpen with no request in flight to ever resolve it, surfacing minutes later as a
   * spurious "didn't go through" (I5's timeout only makes that wait longer). */
  private startFocus(cmd: Extract<Command, { type: 'focus' }>, text: string, now: number, source: Source, recordUserTurn = true, turnId = ''): void {
    const requestId = this.d.newId();
    try {
      this.d.send({ v: 1, type: 'focus', requestId, target: cmd.target, kind: cmd.kind });
    } catch {
      this.trace.addSent(turnId, { type: 'focus', payload: { target: cmd.target, kind: cmd.kind } });
      this.trace.addResult(turnId, { type: 'focus_result', ok: false, ms: 0 });
      this.trace.finishTurn(turnId);
      this.say(`I can't switch to "${cmd.target}" — that name's not valid.`, 'reply', { speak: this.speakForCommandConfirmation(source) });
      return;
    }
    this.trace.addSent(turnId, { type: 'focus', payload: { target: cmd.target, kind: cmd.kind } });
    this.pendingFocus = { requestId, target: cmd.target, kind: cmd.kind, source, at: now, turnId };
    if (recordUserTurn) this.d.memory.addTurn('user', text, now);
  }

  private startOpenUrl(cmd: Extract<Command, { type: 'open_url' }>, text: string, now: number, source: Source, recordUserTurn = true, turnId = ''): void {
    const requestId = this.d.newId();
    try {
      this.d.send({ v: 1, type: 'open_url', requestId, url: cmd.url, ...(cmd.browser ? { browser: cmd.browser } : {}) });
    } catch {
      this.trace.addSent(turnId, { type: 'open_url', payload: { url: cmd.url, label: cmd.label, ...(cmd.browser ? { browser: cmd.browser } : {}) } });
      this.trace.addResult(turnId, { type: 'open_url_result', ok: false, ms: 0 });
      this.trace.finishTurn(turnId);
      this.say(`I can't open "${cmd.label}" — that link's not valid.`, 'reply', { speak: this.speakForCommandConfirmation(source) });
      return;
    }
    this.trace.addSent(turnId, { type: 'open_url', payload: { url: cmd.url, label: cmd.label, ...(cmd.browser ? { browser: cmd.browser } : {}) } });
    this.pendingOpen = { requestId, label: cmd.label, source, at: now, turnId };
    if (recordUserTurn) this.d.memory.addTurn('user', text, now);
  }

  private async onChip(id: string, choice: string): Promise<void> {
    if (await this.handleToolChip(id, choice)) return;
    const now = this.d.clock();
    this.pendingOffer = undefined;
    const command = choice.trim().toLowerCase();
    if (command === SHH || command === SHH_TODAY) {
      this.resolve(id, 'muted');
      return command === SHH ? this.mute(now + MUTE_MS, TEXT.muted30) : this.mute(nextLocalMidnight(now), TEXT.mutedToday);
    }
    if (command === DISMISS) return this.resolve(id, 'ignored');
    if (command.startsWith('paste into') && this.lastDraft?.id === id) {
      this.resolve(id, 'engaged');
      this.triggerPaste(now, 'chat');
      return;
    }
    // M7: "Open <host>" on a model-proposed url that wasn't a known-site result (see answer()) — the only
    // chip click that ever opens something, and only because the USER is now explicitly asking for it.
    const confirm = this.pendingUrlConfirm;
    if (confirm && confirm.nudgeId === id) {
      this.pendingUrlConfirm = undefined;
      if (now - confirm.at < URL_CONFIRM_TTL_MS && command === `open ${confirm.host}`.toLowerCase()) {
        this.resolve(id, 'engaged');
        this.startOpenUrl({ type: 'open_url', url: confirm.url, label: confirm.label }, choice, now, 'chat', false);
        return;
      }
      // Dismissed or stale: fall through to the normal chip handling below (e.g. the "dismiss" chip itself).
    }
    this.resolve(id, 'engaged');
    const original = this.recentTexts.get(id);
    // C1: a chip click's prompt text may quote model/screen-authored wording (the nudge text, the chip
    // label) — it is NEVER the user's own utterance, so no intentText is passed and no action can execute
    // for this turn (chat.ts strips any ```action block outright when intentText is undefined).
    await this.answer(original ? `I clicked "${choice}" on what you said: "${original}"` : choice, 'chat', undefined);
  }

  // ---- nudging ------------------------------------------------------------

  private maybeRequestKeyframe(now: number): void {
    if (!this.d.keyframesEnabled || !this.online) return;
    const cur = this.d.timeline.current();
    const key = this.d.timeline.contextKey();
    if (!cur || !key || cur.msg.private) return;
    if (!this.d.policy.canSpeak(now, this.activity).ok) return;
    if (!this.d.look.shouldLook(cur.msg, key, this.d.timeline.dwellMs(now), now)) return;
    this.d.look.record(key, now);
    this.d.send({ v: 1, type: 'request_keyframe', reason: 'visual context' });
  }

  /** Returns true when the model was consulted. */
  private async maybeNudge(trigger: Trigger | null, priority: Priority): Promise<boolean> {
    if (this.deciding || !this.online) return false;
    const now = this.d.clock();
    const cur = this.d.timeline.current();
    if (!cur || cur.msg.private) return false;
    const opts = { trigger: trigger !== null };
    if (!this.d.policy.canSpeak(now, this.activity, opts).ok) return false;

    const key = this.d.timeline.contextKey();
    const kf = this.keyframe;
    const keyframe = kf && kf.key === key && now - kf.ts < KEYFRAME_FRESH_MS ? kf.jpeg : undefined;
    this.deciding = true;
    try {
      const decision = await this.d.decider.decide(
        {
          userName: this.d.config.user.name,
          timeline: this.d.timeline.render(now),
          current: cur.msg,
          activity: this.activity,
          trigger,
          allowQuip: this.d.policy.allowQuip(),
          incidentMode: isIncident(cur.msg) || trigger?.kind === 'alert_page',
          facts: this.d.memory.facts(),
          ...(keyframe ? { keyframe } : {}),
        },
        priority,
      );
      this.announceRecoveryIfNeeded();
      if (decision) this.deliver(decision, opts);
    } catch (err) {
      this.onModelError(err);
    } finally {
      this.deciding = false;
    }
    return true;
  }

  private deliver(decision: NudgeDecision, opts: { trigger: boolean }): void {
    const now = this.d.clock();
    if (!this.d.policy.canSpeak(now, this.activity, opts).ok) {
      this.d.log.info('nudge_dropped', { reason: 'no longer allowed to speak' });
      return;
    }
    const id = this.d.newId();
    this.d.policy.recordSpoke(now, decision.kind);
    this.d.memory.logNudge({ id, ts: now, kind: decision.kind, text: decision.text });
    this.pending = [...this.pending, { id, at: now }];
    this.recentTexts = new Map([...this.recentTexts, [id, decision.text] as const].slice(-RECENT_TEXTS));
    this.d.send({
      v: 1,
      type: 'say',
      nudgeId: id,
      text: decision.text,
      kind: decision.kind,
      chips: withShh(decision.chips),
      speak: this.d.config.voice.enabled && this.d.config.voice.speakNudges,
      ...(decision.pointAt ? { pointAt: decision.pointAt } : {}),
    });
    this.rememberOffer(decision.text);
  }

  // ---- outcomes -------------------------------------------------------------

  private expirePending(now: number): void {
    const ignoreAfterMs = this.d.config.nudge.ignoreAfterSec * 1000;
    for (const p of this.pending.filter((p) => now - p.at >= ignoreAfterMs)) this.resolve(p.id, 'ignored');
  }

  private onFocusResult(msg: FocusResultMsg): void {
    const p = this.pendingFocus;
    if (!p || p.requestId !== msg.requestId) return;
    this.pendingFocus = undefined;
    const now = this.d.clock();
    const text = msg.ok
      ? `Switched to ${msg.matched ?? p.target}.`
      : `I can't find ${p.kind === 'window' ? 'a window' : 'an app'} called "${p.target}".`;
    this.say(text, 'reply', { speak: this.speakForCommandConfirmation(p.source) });
    this.d.memory.addTurn('assistant', text, now);
    this.trace.addResult(p.turnId, { type: 'focus_result', ok: msg.ok, ...(msg.matched ? { matched: msg.matched } : {}), ms: now - p.at });
    this.trace.finishTurn(p.turnId);
  }

  private expirePendingFocus(now: number): void {
    const p = this.pendingFocus;
    if (!p || now - p.at < FOCUS_TIMEOUT_MS) return;
    this.pendingFocus = undefined;
    this.say("That switch didn't go through.", 'reply', { speak: this.speakForCommandConfirmation(p.source) });
    this.trace.addResult(p.turnId, { type: 'focus_result', ok: false, ms: now - p.at });
    this.trace.finishTurn(p.turnId);
  }

  private onOpenUrlResult(msg: OpenUrlResultMsg): void {
    const p = this.pendingOpen;
    if (!p || p.requestId !== msg.requestId) return;
    this.pendingOpen = undefined;
    const now = this.d.clock();
    // I3: the confirmation always names the SITE (the label), never just the browser it opened in — the
    // body has no idea what "YouTube" is, only which browser it used, so combine both when it reports one.
    const text = msg.ok ? `Opening ${p.label}${msg.opened ? ` in ${msg.opened}` : ''}…` : `I couldn't open ${p.label}.`;
    this.say(text, 'reply', { speak: this.speakForCommandConfirmation(p.source) });
    this.d.memory.addTurn('assistant', text, now);
    this.trace.addResult(p.turnId, { type: 'open_url_result', ok: msg.ok, ...(msg.opened ? { opened: msg.opened } : {}), ms: now - p.at });
    this.trace.finishTurn(p.turnId);
  }

  private expirePendingOpen(now: number): void {
    const p = this.pendingOpen;
    if (!p || now - p.at < OPEN_TIMEOUT_MS) return;
    this.pendingOpen = undefined;
    this.say("That didn't open.", 'reply', { speak: this.speakForCommandConfirmation(p.source) });
    this.trace.addResult(p.turnId, { type: 'open_url_result', ok: false, ms: now - p.at });
    this.trace.finishTurn(p.turnId);
  }

  private clearStalePendingTrigger(now: number): void {
    const p = this.pendingTrigger;
    if (!p) return;
    if (now - p.at >= PENDING_TRIGGER_TTL_MS || p.contextKey !== this.d.timeline.contextKey()) this.pendingTrigger = undefined;
  }

  /** Retries the held-back trigger; clears it once the model has actually been consulted, otherwise leaves it for the next pulse. */
  private async retryPendingTrigger(): Promise<void> {
    const p = this.pendingTrigger;
    if (!p) return;
    const attempted = await this.maybeNudge(p.trigger, PRIORITY.trigger);
    if (attempted) {
      this.d.triggers.mark(p.trigger, this.d.clock());
      this.pendingTrigger = undefined;
    }
  }

  private resolveAll(outcome: NudgeOutcome): void {
    for (const p of this.pending) this.resolve(p.id, outcome);
  }

  private resolve(id: string, outcome: NudgeOutcome): void {
    const wasPending = this.pending.some((p) => p.id === id);
    this.pending = this.pending.filter((p) => p.id !== id);
    if (!wasPending) {
      // A late click on a nudge that already timed out still means the user engaged.
      if (outcome === 'engaged' && this.d.memory.nudgeOutcome(id) === 'ignored') {
        this.d.memory.setNudgeOutcome(id, 'engaged');
        this.d.policy.recordOutcome(true);
      }
      return;
    }
    this.d.memory.setNudgeOutcome(id, outcome);
    if (outcome !== 'muted') this.d.policy.recordOutcome(outcome === 'engaged');
  }

  private mute(until: number, confirmation: string, turnId = ''): void {
    this.d.policy.muteUntil(until);
    this.d.memory.setState(MUTED_STATE_KEY, until);
    this.sayTraced(confirmation, 'status', turnId);
  }

  // ---- chat -------------------------------------------------------------------

  /** `intentText` is the user's own raw utterance for THIS turn, or undefined when this reply is not
   * directly speaking for the user (a chip click — see onChip/C1). It's threaded straight through to
   * chat.ts, the only place a model-proposed action is ever gated. `turnId` is the decision-trace turn this
   * reply belongs to, or '' for a chip-derived reply (out of trace scope — see trace.ts). `preset` lets a
   * post-tool-confirm call (see handleToolChip) hand in the just-run tool's context/success/memory-skip
   * without gathering again — gather() only ever runs for a real user utterance (`intentText !== undefined`),
   * so a preset is never overwritten by a fresh gather on that call. */
  private async answer(
    text: string,
    source: Source,
    intentText: string | undefined,
    turnId = '',
    preset?: { toolResults?: string; toolSucceeded?: { tool: string; serverId: string }; recordUserTurn?: boolean },
  ): Promise<void> {
    const cur = this.d.timeline.current();
    this.d.log.info('chat_ctx', {
      hasCurrent: cur !== undefined,
      app: cur?.msg.app,
      bundleId: cur?.msg.bundleId,
      private: cur?.msg.private,
      ocrChars: cur?.msg.ocrText?.length ?? 0,
      timelineEntries: this.d.timeline.entriesCount(),
    });
    let toolResults = preset?.toolResults;
    let toolSucceeded = preset?.toolSucceeded;
    if (this.d.tools && intentText !== undefined) {
      try {
        const gathered = await this.d.tools.gather({ utterance: text, untrustedText: cur?.msg.private ? '' : (cur?.msg.ocrText ?? '') });
        if (gathered.pending) {
          this.askToolConfirm(gathered.pending, text, source, turnId);
          return;
        }
        toolResults = gathered.toolContext || undefined;
        // N1: gathered.runs are always auto (this.d.tools.gather never runs a confirm-mode tool itself), so
        // lastSuccessfulRun is always undefined here — kept for symmetry with the post-confirm path below,
        // and so this stays correct if gather's contract ever changes.
        toolSucceeded = lastSuccessfulRun(gathered.runs);
      } catch (err) {
        // M7: a class name only (never the error message, which could echo tool args/results) — diagnostics,
        // not content, per the log constraint.
        this.d.log.warn('tool_gather_failed', { error: err instanceof Error ? err.name : 'Error' });
      }
    }
    try {
      const reply = await this.d.chat.reply(text, {
        timeline: this.d.timeline.render(this.d.clock()),
        ...(cur ? { current: cur.msg } : {}),
        incidentMode: isIncident(cur?.msg),
        intentText,
        turnId,
        ...(toolResults ? { toolResults } : {}),
        ...(toolSucceeded ? { toolSucceeded } : {}),
        ...(preset?.recordUserTurn === false ? { recordUserTurn: false } : {}),
      });
      this.announceRecoveryIfNeeded();

      // M7: a model-chosen URL that isn't one of our own known-site homepage/search results (i.e. not
      // something sites.ts itself would have built) is confirmed with the user first, via an "Open <host>"
      // chip, rather than opened automatically — a specific video/page/login page is not the same trust
      // level as "the YouTube homepage" or "a YouTube search".
      const urlAction = reply.action?.open === 'url' ? reply.action : undefined;
      const needsConfirm = urlAction !== undefined && !isKnownSiteResult(urlAction.url);
      // N5: a draft and a confirm-needed url in the same reply is a rare, awkward combination. Simplest and
      // safest: drop the open action entirely rather than combine chip sets (the draft's "paste into
      // <App>" chip alongside an "Open <host>" chip) or silently auto-open something unconfirmed.
      const dropForDraft = needsConfirm && Boolean(reply.draft);
      const host = needsConfirm && !dropForDraft ? hostOf(urlAction!.url) : undefined;

      // N5: the model's own line can read like the open is already happening ("Opening the playlist for
      // you now.") even though Coco is either about to ask first, or (dropForDraft) not opening it at all —
      // replace a line that implies that with an honest one instead of showing it next to an unopened chip.
      const impliesOpening = reply.text === '' || claimsPendingAction(reply.text);
      const deliveryText = host && impliesOpening ? `Want me to open ${urlAction!.label}?` : reply.text;

      const sayId = this.deliverChatReply({ ...reply, text: deliveryText }, cur?.msg, source, host ? [`Open ${host}`, 'dismiss'] : undefined, turnId);
      this.rememberOffer(deliveryText);

      const executesAction = Boolean(reply.action && !needsConfirm);
      if (executesAction) {
        this.executeModelAction(reply.action!, text, source, turnId);
      } else if (host && urlAction && sayId) {
        this.pendingUrlConfirm = { nudgeId: sayId, url: urlAction.url, label: urlAction.label, host, at: this.d.clock() };
      }
      // An executed action finishes the trace turn later, once its focus_result/open_url_result arrives
      // (see startFocus/startOpenUrl); anything else (a plain reply, or one awaiting an "Open <host>"
      // confirm chip that's out of trace scope) has nothing further to wait for.
      if (!executesAction) this.trace.finishTurn(turnId);
    } catch (err) {
      const wasOnline = this.online;
      this.onModelError(err);
      if (!(err instanceof ModelUnavailableError)) this.sayTraced(TEXT.genericError, 'reply', turnId);
      else if (!wasOnline) this.sayTraced(TEXT.offlineReply, 'reply', turnId);
      else this.trace.finishTurn(turnId);
    }
  }

  /** N2: whether `text` should be read as "yes, run the pending confirm" — offers.ts's general
   * affirmations plus the chip's own label ("run it") and its obvious synonym ("confirm"). Never anything
   * else: this is deliberately narrow, since a false positive here would run a write off a typed word
   * instead of a button click. */
  private isToolConfirmAffirmation(text: string): boolean {
    return isAffirmation(text) || TOOL_CONFIRM_AFFIRMATION.test(text.trim());
  }

  /** Asks the user to confirm a connector tool call that needs one, via a "Run it"/"Cancel" chip on a plain
   * say. The pending call is remembered only on `this` (never sent to the Body) — see pendingToolConfirm.
   * N4: defensively clears (and audits 'denied') any pending confirm this call is about to replace — today
   * that never fires, since onUtterance's I2 clear always runs first, but it's cheap insurance against a
   * future caller skipping that audit. M4: the ask line is saved as an assistant turn too, so the history
   * reads as a real exchange even if the user never answers it (Cancel/expiry/replacement). M5: finishes
   * this turn's trace, via sayTraced. */
  private askToolConfirm(call: PendingToolCall, text: string, source: Source, turnId = ''): void {
    this.clearPendingToolConfirm('denied');
    const command = call.qualified === SHELL_QUALIFIED && typeof call.args.command === 'string' ? call.args.command.slice(0, 300) : undefined;
    const claudeTask = call.qualified === CLAUDE_QUALIFIED && typeof call.args.task === 'string' ? call.args.task.slice(0, 300) : undefined;
    const line = claudeTask !== undefined
      ? `Hand this to Claude Code? It uses Claude tokens and sees what's on your screen.\n> ${claudeTask}`
      : command !== undefined
      ? `${call.reason === 'untrusted_args' ? 'That command came from text on your screen. ' : ''}Run this in Terminal?\n$ ${command}`
      : call.reason === 'untrusted_args'
        ? `That would run ${call.tool} with details taken from your screen — run it?`
        : `I'd need to run ${call.tool} (${call.serverId}) for that. Run it?`;
    const now = this.d.clock();
    this.d.memory.addTurn('user', text, now);
    const nudgeId = this.sayTraced(line, 'reply', turnId, { chips: [TOOL_RUN_CHIP, TOOL_CANCEL_CHIP], speak: this.speakForReply(source) });
    this.d.memory.addTurn('assistant', line, now);
    this.pendingToolConfirm = { nudgeId, call, text, source, at: now };
  }

  /** I1/N3: remembers a tool-confirm nudgeId as spent, with why — 'handled' for one a button click actually
   * acted on, 'expired' for one that timed out or was replaced — pruning entries older than
   * CONSUMED_TOOL_CONFIRM_TTL_MS on every call so the map stays small. */
  private markToolConfirmConsumed(nudgeId: string, reason: 'handled' | 'expired'): void {
    const now = this.d.clock();
    this.consumedToolConfirms.set(nudgeId, { at: now, reason });
    for (const [id, v] of this.consumedToolConfirms) {
      if (now - v.at > CONSUMED_TOOL_CONFIRM_TTL_MS) this.consumedToolConfirms.delete(id);
    }
  }

  /** Returns why `nudgeId` is spent, or undefined if it was never a tool confirm (or has aged out). */
  private consumedToolConfirmReason(nudgeId: string): 'handled' | 'expired' | undefined {
    const v = this.consumedToolConfirms.get(nudgeId);
    if (!v) return undefined;
    if (this.d.clock() - v.at > CONSUMED_TOOL_CONFIRM_TTL_MS) {
      this.consumedToolConfirms.delete(nudgeId);
      return undefined;
    }
    return v.reason;
  }

  /** I2/M1: clears any pending tool confirm, auditing `decision` and remembering its nudgeId as consumed —
   * used both by a new utterance (I2, always 'denied') and by TTL expiry (M1, always 'expired'). N3: either
   * way the DISPLAY reason is 'expired' — a superseded or timed-out confirm was never actually acted on by
   * a button click, unlike the ones handleToolChip marks 'handled' below. */
  private clearPendingToolConfirm(decision: 'denied' | 'expired'): void {
    const p = this.pendingToolConfirm;
    if (!p) return;
    this.pendingToolConfirm = undefined;
    this.markToolConfirmConsumed(p.nudgeId, 'expired');
    this.d.tools?.recordDecision(p.call, decision);
  }

  /** Returns true if the chip belonged to a tool confirmation — live, or a spent/expired/superseded one
   * (handled here either way, so nothing ever falls through to a generic model turn with no tool result). */
  private async handleToolChip(id: string, choice: string): Promise<boolean> {
    const p = this.pendingToolConfirm;
    if (!p || p.nudgeId !== id) {
      // I1/N3: a click on a bubble that already ran/was denied ('handled'), or timed out/was superseded
      // ('expired') — worded differently since only the first was actually acted on by a button click.
      const reason = this.consumedToolConfirmReason(id);
      if (!reason) return false;
      this.say(reason === 'handled' ? TOOL_CONFIRM_HANDLED_TEXT : TOOL_CONFIRM_EXPIRED_TEXT, 'reply', { speak: this.speakForReply('chat') });
      return true;
    }
    this.pendingToolConfirm = undefined;
    // M1: a late click that beat pulse() to it is still an expiry, audited and answered the same way.
    if (this.d.clock() - p.at > TOOL_CONFIRM_TTL_MS) {
      this.markToolConfirmConsumed(id, 'expired');
      this.d.tools?.recordDecision(p.call, 'expired');
      this.say(TOOL_CONFIRM_EXPIRED_TEXT, 'reply', { speak: this.speakForReply(p.source) });
      return true;
    }
    // Beyond this point the click is real and in-window — every branch below is a genuine "handled" outcome
    // (run, failed, turned off, or cancelled), so a repeat click on this id gets TOOL_CONFIRM_HANDLED_TEXT.
    this.markToolConfirmConsumed(id, 'handled');
    // M6: match every other chip comparison in this file (trimmed + lowercased). Anything other than "run
    // it" — including a mistyped choice or "shh" — denies; that is the safe default.
    if (choice.trim().toLowerCase() === TOOL_RUN_CHIP.toLowerCase() && this.d.tools) {
      let res: GatherResult;
      try {
        res = await this.d.tools.runConfirmed(p.call);
      } catch (err) {
        // M2: runConfirmed can reject (e.g. ensureConnected/connect rethrowing) — the pending confirm is
        // already cleared above, so the click must not vanish silently.
        this.d.log.warn('tool_run_failed', { error: err instanceof Error ? err.name : 'Error' });
        this.say(`Couldn't run ${p.call.tool} — it failed, and nothing was changed.`, 'reply', { speak: this.speakForReply(p.source) });
        return true;
      }
      if (res.runs.length === 0) {
        // M3: the tool was switched off between the ask and the click (loop.ts's runConfirmed returns no
        // runs for an off-autonomy call) — say so, rather than asking the model to answer with no result and
        // no TOOL_RULE.
        this.say(`${p.call.tool} is turned off in Studio — nothing ran.`, 'reply', { speak: this.speakForReply(p.source) });
        return true;
      }
      // M4: `p.text`'s user turn was already recorded when the ask was shown — never record it twice.
      await this.answer(p.text, p.source, undefined, '', {
        toolResults: res.toolContext || undefined,
        toolSucceeded: lastSuccessfulRun(res.runs),
        recordUserTurn: false,
      });
      return true;
    }
    this.d.tools?.recordDecision(p.call, 'denied');
    this.say("Okay — I won't run it.", 'reply', { speak: this.speakForReply(p.source) });
    return true;
  }

  private expirePendingToolConfirm(now: number): void {
    const p = this.pendingToolConfirm;
    if (p && now - p.at > TOOL_CONFIRM_TTL_MS) this.clearPendingToolConfirm('expired');
  }

  /** Executes a model-proposed action the same way a parsed command would (focus for an app, open_url for a
   * website): `recordUserTurn: false` since chat.reply() already recorded this turn in memory. */
  private executeModelAction(action: ModelAction, text: string, source: Source, turnId = ''): void {
    const now = this.d.clock();
    if (action.open === 'app') {
      this.startFocus({ type: 'focus', target: action.target, kind: 'app' }, text, now, source, false, turnId);
    } else {
      this.startOpenUrl({ type: 'open_url', url: action.url, label: action.label }, text, now, source, false, turnId);
    }
  }

  /** Sends the chat reply as a say; when it carries a draft and the current context is a known, non-private
   * app, attaches draftApp/the paste chip and remembers it as lastDraft. Speaks only `text`, never `draft`
   * — the Body speaks the say's `text` field, which extractDraft has already stripped of any draft content.
   * An empty `text` (the model's own completion-claim line was dropped alongside a still-pending action)
   * sends no bubble at all — the action's result handler speaks for that turn instead. `extraChips` (M7's
   * "Open <host>"/"dismiss") are appended to a draft-less reply's say. Returns the say's id (for
   * pendingUrlConfirm to correlate the chip click), or undefined when nothing was sent. */
  private deliverChatReply(
    reply: ChatReply,
    current: ContextMsg | undefined,
    source: Source,
    extraChips?: readonly string[],
    turnId = '',
  ): string | undefined {
    const speak = this.speakForReply(source);
    if (!reply.draft) {
      this.lastDraft = undefined;
      if (reply.text === '') return undefined;
      const id = this.say(reply.text, 'reply', { speak, ...(extraChips ? { chips: extraChips } : {}) });
      this.trace.addSent(turnId, { type: 'say', payload: { text: reply.text, hasDraft: false } });
      return id;
    }
    const app = current && !current.private ? current.app : undefined;
    if (!app) {
      this.lastDraft = undefined;
      const id = this.say(reply.text, 'reply', { draft: reply.draft, speak });
      this.trace.addSent(turnId, { type: 'say', payload: { text: reply.text, hasDraft: true, draft: reply.draft } });
      return id;
    }
    const id = this.say(reply.text, 'reply', { draft: reply.draft, draftApp: app, chips: [`paste into ${app}`], speak });
    this.lastDraft = { id, text: reply.draft, app, at: this.d.clock() };
    this.trace.addSent(turnId, { type: 'say', payload: { text: reply.text, hasDraft: true, draft: reply.draft, draftApp: app } });
    return id;
  }

  /** Pastes the current draft, or explains there isn't one (missing or stale). The ONLY entry point for the paste flow. */
  private triggerPaste(now: number, source: Source, turnId = ''): void {
    const draft = this.lastDraft;
    if (!draft || now - draft.at >= DRAFT_TTL_MS) {
      this.sayTraced("There's no draft to paste yet.", 'reply', turnId);
      return;
    }
    const requestId = this.d.newId();
    this.pendingPaste = { requestId, app: draft.app, source, at: now, turnId };
    this.trace.addSent(turnId, { type: 'paste', payload: { app: draft.app, text: draft.text } });
    this.d.send({ v: 1, type: 'paste', requestId, text: draft.text, app: draft.app });
  }

  private onPasteResult(msg: PasteResultMsg): void {
    const p = this.pendingPaste;
    if (!p || p.requestId !== msg.requestId) return;
    this.pendingPaste = undefined;
    const now = this.d.clock();
    const text = msg.ok
      ? `Pasted into ${p.app} — press Enter to send.`
      : `Couldn't paste into ${p.app}: ${msg.detail ?? 'no text box found'}.`;
    this.say(text, 'reply', { speak: this.speakForCommandConfirmation(p.source) });
    this.trace.addResult(p.turnId, { type: 'paste_result', ok: msg.ok, ms: now - p.at });
    this.trace.finishTurn(p.turnId);
  }

  private expirePendingPaste(now: number): void {
    const p = this.pendingPaste;
    if (!p || now - p.at < PASTE_TIMEOUT_MS) return;
    this.pendingPaste = undefined;
    this.say("The paste didn't go through.", 'reply', { speak: this.speakForCommandConfirmation(p.source) });
    this.trace.addResult(p.turnId, { type: 'paste_result', ok: false, ms: now - p.at });
    this.trace.finishTurn(p.turnId);
  }

  // ---- health & mood ----------------------------------------------------------

  private onModelError(err: unknown): void {
    this.d.log.error('model_error', { error: err instanceof Error ? err.message : String(err) });
    // A ModelRequestError (bad request) is not a reachability problem: log it and treat it as "no decision".
    if (!(err instanceof ModelUnavailableError)) return;
    // Discovered offline outside the health-check timer: let the next checkHealth() run immediately rather than honor a stale backoff.
    this.healthBackoffMs = 0;
    this.nextHealthCheckAt = 0;
    this.goOffline();
  }

  /** Flips online -> false and announces it (subject to the busy/mute gate). Idempotent while already offline; never touches health backoff. */
  private goOffline(): void {
    if (!this.online) return;
    this.online = false;
    this.awaitingRecovery = true;
    this.d.log.warn('brain_online_changed', { online: false });
    this.updateMood();
    this.sayStatusIfAllowed(TEXT.offline);
  }

  /** health() true clears the gate that blocks unsolicited model calls, but never itself announces "I'm back" — see announceRecoveryIfNeeded. */
  private clearOfflineGating(): void {
    if (this.online) return;
    this.online = true;
    this.d.log.info('brain_health_recovered');
    this.updateMood();
  }

  /** Called after any successful model call (decide or chat). Announces recovery once, the first time it happens after an offline period. */
  private announceRecoveryIfNeeded(): void {
    if (!this.awaitingRecovery) return;
    this.awaitingRecovery = false;
    if (!this.online) {
      this.online = true;
      this.healthBackoffMs = 0;
      this.nextHealthCheckAt = 0;
    }
    this.updateMood();
    this.sayStatusIfAllowed(TEXT.online);
  }

  /** Offline/online status bubbles must not interrupt or fight with the user: suppressed while muted or busy, logged instead. */
  private sayStatusIfAllowed(text: string): void {
    const now = this.d.clock();
    if (this.d.policy.isMuted(now) || BUSY.has(this.activity)) {
      this.d.log.info('status_suppressed', { text, activity: this.activity });
      return;
    }
    this.say(text, 'status');
  }

  private computeMood(): Mood {
    if (!this.online) return 'sleepy';
    if (isIncident(this.d.timeline.current()?.msg)) return 'worried';
    if (BUSY.has(this.activity)) return 'focused';
    if (this.activity === 'idle') return 'bored';
    return 'curious';
  }

  private updateMood(): void {
    const mood = this.computeMood();
    if (mood === this.mood) return;
    this.mood = mood;
    this.d.send({ v: 1, type: 'mood', mood });
  }

  /** Reply to an utterance: voice always speaks (when voice is enabled); typed chat speaks only when speakTypedReplies is on. */
  private speakForReply(source: Source): boolean {
    return source === 'voice' ? this.d.config.voice.enabled : this.d.config.voice.enabled && this.d.config.voice.speakTypedReplies;
  }

  /** Confirmation of a focus/paste command: speaks only when that command itself arrived by voice. */
  private speakForCommandConfirmation(source: Source): boolean {
    return source === 'voice' && this.d.config.voice.enabled;
  }

  /** Sends a status/reply say. Returns the nudgeId, so callers can correlate a later "paste into <App>" chip with the draft it belongs to. */
  private say(
    text: string,
    kind: Extract<SayKind, 'status' | 'reply'>,
    extra?: { chips?: readonly string[]; draft?: string; draftApp?: string; speak?: boolean },
  ): string {
    const id = this.d.newId();
    this.d.send({
      v: 1,
      type: 'say',
      nudgeId: id,
      text,
      kind,
      chips: extra?.chips ? [...extra.chips] : [],
      speak: extra?.speak ?? false,
      ...(extra?.draft ? { draft: extra.draft } : {}),
      ...(extra?.draftApp ? { draftApp: extra.draftApp } : {}),
    });
    return id;
  }

  /** `say()`, plus recording it as this turn's `sent` and immediately finishing the trace turn — for a
   * route with no further device round-trip to wait for (mute, clear, "no draft to paste", a model-error
   * fallback). Routes that DO have one (focus/open_url/paste) record their own `sent`/`result` and finish
   * later, once that result arrives — see startFocus/startOpenUrl/triggerPaste and their *Result handlers. */
  private sayTraced(
    text: string,
    kind: Extract<SayKind, 'status' | 'reply'>,
    turnId: string,
    extra?: { chips?: readonly string[]; draft?: string; draftApp?: string; speak?: boolean },
  ): string {
    const id = this.say(text, kind, extra);
    this.trace.addSent(turnId, { type: 'say', payload: { text, kind } });
    this.trace.finishTurn(turnId);
    return id;
  }
}

function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
