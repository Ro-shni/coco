import type { ChatContext } from './chat.js';
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
import type { ExtractedDraft } from './persona/drafts.js';
import type { NudgeDecision } from './persona/decision.js';
import type { DecideInput } from './persona/decider.js';
import type { ActivityState, BodyToBrain, BrainToBody, ContextMsg, FocusResultMsg, KeyframeMsg, Mood, PasteResultMsg, SayKind } from './protocol.js';

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
  chat: { reply(text: string, ctx: ChatContext): Promise<ExtractedDraft> };
  memory: Memory;
  gateway: Pick<ModelGateway, 'health'>;
  keyframesEnabled: boolean;
  log: Logger;
}

interface PendingNudge {
  id: string;
  at: number;
}

interface PendingTrigger {
  trigger: Trigger;
  contextKey: string;
  at: number;
}

interface PendingFocus {
  requestId: string;
  target: string;
  kind: Command['kind'];
  at: number;
}

interface PendingOffer {
  target: string;
  kind: 'app';
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
  at: number;
}

const KEYFRAME_FRESH_MS = 60_000;
const OFFER_TTL_MS = 120_000;
const FOCUS_TIMEOUT_MS = 5000;
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

export class Orchestrator {
  private activity: ActivityState = 'reading';
  private keyframe: { key: string; jpeg: string; ts: number } | undefined;
  private pending: readonly PendingNudge[] = [];
  private pendingTrigger: PendingTrigger | undefined;
  private pendingFocus: PendingFocus | undefined;
  /** A "bring X to the front" offer Coco just made; a bare "sure" within OFFER_TTL_MS accepts it. */
  private pendingOffer: PendingOffer | undefined;
  /** The most recent draft Coco offered to paste (non-private context only); stale after DRAFT_TTL_MS. */
  private lastDraft: PendingDraft | undefined;
  private pendingPaste: PendingPaste | undefined;
  private recentTexts: ReadonlyMap<string, string> = new Map();
  private deciding = false;
  private mood: Mood | undefined;
  private online = true;
  /** True while offline and no successful model call has announced recovery yet. */
  private awaitingRecovery = false;
  private healthBackoffMs = 0;
  private nextHealthCheckAt = 0;
  private lastContextLog: { app: string; bundleId: string; ocrChars: number } | undefined;

  constructor(private readonly d: OrchestratorDeps) {
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
        return this.onUtterance(msg.text);
      case 'chip':
        return this.onChip(msg.nudgeId, msg.choice);
      case 'focus_result':
        return this.onFocusResult(msg);
      case 'paste_result':
        return this.onPasteResult(msg);
    }
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
    this.expirePendingPaste(now);
    this.clearStalePendingTrigger(now);
    this.maybeRequestKeyframe(now);
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

  private async onUtterance(text: string): Promise<void> {
    const now = this.d.clock();
    this.resolveAll('engaged');
    const offer = this.takeOffer(now);
    if (offer && isAffirmation(text)) return this.startFocus({ type: 'focus', target: offer.target, kind: offer.kind }, text, now);
    if (PASTE_UTTERANCE.test(text.trim())) return this.triggerPaste(now);
    const command = text.trim().toLowerCase();
    if (command === SHH) return this.mute(now + MUTE_MS, TEXT.muted30);
    if (command === SHH_TODAY) return this.mute(nextLocalMidnight(now), TEXT.mutedToday);
    if (command === UNMUTE) return this.mute(now, TEXT.unmuted);
    if (command === CLEAR_CHAT || command === FORGET_CHAT) {
      this.d.memory.clearTurns();
      this.say(TEXT.chatCleared, 'reply');
      return;
    }
    const cmd = parseCommand(text);
    if (cmd) return this.startFocus(cmd, text, now);
    await this.answer(text);
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

  private startFocus(cmd: Command, text: string, now: number): void {
    const requestId = this.d.newId();
    this.pendingFocus = { requestId, target: cmd.target, kind: cmd.kind, at: now };
    this.d.send({ v: 1, type: 'focus', requestId, target: cmd.target, kind: cmd.kind });
    this.d.memory.addTurn('user', text, now);
  }

  private async onChip(id: string, choice: string): Promise<void> {
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
      this.triggerPaste(now);
      return;
    }
    this.resolve(id, 'engaged');
    const original = this.recentTexts.get(id);
    await this.answer(original ? `I clicked "${choice}" on what you said: "${original}"` : choice);
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
      speak: false,
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
    this.say(text, 'reply');
    this.d.memory.addTurn('assistant', text, now);
  }

  private expirePendingFocus(now: number): void {
    const p = this.pendingFocus;
    if (!p || now - p.at < FOCUS_TIMEOUT_MS) return;
    this.pendingFocus = undefined;
    this.say("That switch didn't go through.", 'reply');
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

  private mute(until: number, confirmation: string): void {
    this.d.policy.muteUntil(until);
    this.d.memory.setState(MUTED_STATE_KEY, until);
    this.say(confirmation, 'status');
  }

  // ---- chat -------------------------------------------------------------------

  private async answer(text: string): Promise<void> {
    const cur = this.d.timeline.current();
    this.d.log.info('chat_ctx', {
      hasCurrent: cur !== undefined,
      app: cur?.msg.app,
      bundleId: cur?.msg.bundleId,
      private: cur?.msg.private,
      ocrChars: cur?.msg.ocrText?.length ?? 0,
      timelineEntries: this.d.timeline.entriesCount(),
    });
    try {
      const reply = await this.d.chat.reply(text, {
        timeline: this.d.timeline.render(this.d.clock()),
        ...(cur ? { current: cur.msg } : {}),
        incidentMode: isIncident(cur?.msg),
      });
      this.announceRecoveryIfNeeded();
      this.deliverChatReply(reply, cur?.msg);
      this.rememberOffer(reply.text);
    } catch (err) {
      const wasOnline = this.online;
      this.onModelError(err);
      if (!(err instanceof ModelUnavailableError)) this.say(TEXT.genericError, 'reply');
      else if (!wasOnline) this.say(TEXT.offlineReply, 'reply');
    }
  }

  /** Sends the chat reply as a say; when it carries a draft and the current context is a known, non-private app, attaches draftApp/the paste chip and remembers it as lastDraft. */
  private deliverChatReply(reply: ExtractedDraft, current: ContextMsg | undefined): void {
    if (!reply.draft) {
      this.lastDraft = undefined;
      this.say(reply.text, 'reply');
      return;
    }
    const app = current && !current.private ? current.app : undefined;
    if (!app) {
      this.lastDraft = undefined;
      this.say(reply.text, 'reply', { draft: reply.draft });
      return;
    }
    const id = this.say(reply.text, 'reply', { draft: reply.draft, draftApp: app, chips: [`paste into ${app}`] });
    this.lastDraft = { id, text: reply.draft, app, at: this.d.clock() };
  }

  /** Pastes the current draft, or explains there isn't one (missing or stale). The ONLY entry point for the paste flow. */
  private triggerPaste(now: number): void {
    const draft = this.lastDraft;
    if (!draft || now - draft.at >= DRAFT_TTL_MS) {
      this.say("There's no draft to paste yet.", 'reply');
      return;
    }
    const requestId = this.d.newId();
    this.pendingPaste = { requestId, app: draft.app, at: now };
    this.d.send({ v: 1, type: 'paste', requestId, text: draft.text, app: draft.app });
  }

  private onPasteResult(msg: PasteResultMsg): void {
    const p = this.pendingPaste;
    if (!p || p.requestId !== msg.requestId) return;
    this.pendingPaste = undefined;
    const text = msg.ok
      ? `Pasted into ${p.app} — press Enter to send.`
      : `Couldn't paste into ${p.app}: ${msg.detail ?? 'no text box found'}.`;
    this.say(text, 'reply');
  }

  private expirePendingPaste(now: number): void {
    const p = this.pendingPaste;
    if (!p || now - p.at < PASTE_TIMEOUT_MS) return;
    this.pendingPaste = undefined;
    this.say("The paste didn't go through.", 'reply');
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

  /** Sends a status/reply say. Returns the nudgeId, so callers can correlate a later "paste into <App>" chip with the draft it belongs to. */
  private say(
    text: string,
    kind: Extract<SayKind, 'status' | 'reply'>,
    extra?: { chips?: readonly string[]; draft?: string; draftApp?: string },
  ): string {
    const id = this.d.newId();
    this.d.send({
      v: 1,
      type: 'say',
      nudgeId: id,
      text,
      kind,
      chips: extra?.chips ? [...extra.chips] : [],
      speak: false,
      ...(extra?.draft ? { draft: extra.draft } : {}),
      ...(extra?.draftApp ? { draftApp: extra.draftApp } : {}),
    });
    return id;
  }
}
