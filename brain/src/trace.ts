import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from './commands.js';
import type { ModelAction } from './persona/actions.js';
import type { NudgeDecision } from './persona/decision.js';

/** Where the utterance came from — mirrors orchestrator.ts's own `Source` type (not imported to avoid a
 * dependency edge back onto orchestrator.ts; the two are kept in lockstep by trace.test.ts). */
export type TraceSource = 'voice' | 'chat';

/** Which branch of onUtterance handled this turn. */
export type TraceRouteVia = 'offer' | 'paste' | 'mute' | 'clear' | 'command' | 'model';

export interface TraceRoute {
  via: TraceRouteVia;
  /** The parsed command, only for `via: 'command'`. */
  command?: Command;
}

export type TraceModelCallPurpose = 'reply' | 'honesty_rewrite' | 'draft_rewrite' | 'nudge';

export interface TraceModelCall {
  /** 1-based sequence number of this call within its reply()/decide() invocation. */
  n: number;
  purpose: TraceModelCallPurpose;
  /** Wall-clock milliseconds the call took. */
  ms: number;
  /** The model's raw reply text, before draft/action extraction. */
  rawReply: string;
}

export interface TraceExtracted {
  text: string;
  /** Whether a draft was extracted (never the draft text itself). */
  draft?: boolean;
  action?: ModelAction;
  actionBlockPresent: boolean;
}

export interface TraceGate {
  allowed: boolean;
  reason: string;
}

export type TraceSentType = 'focus' | 'open_url' | 'say' | 'paste';

export interface TraceSent {
  type: TraceSentType;
  /** A summary of what was sent — never more than what was already sent to the Body/said aloud. */
  payload: Record<string, unknown>;
}

export interface TraceResult {
  type: string;
  ok: boolean;
  matched?: string;
  opened?: string;
  /** Milliseconds since the corresponding `sent` entry. */
  ms: number;
}

export interface TraceNudgeDecisionRecord {
  modelCalls: readonly TraceModelCall[];
  decision: NudgeDecision | null;
  selfcheckProblems: readonly string[];
}

/**
 * Records one JSON-line-per-turn decision trace, gated entirely by config `debug.trace` (see config.ts's
 * DEFAULT_CONFIG and README): when it's off, `createDecisionTrace` returns a no-op implementation and every
 * call here is a cheap, immediate return — no turn state is ever buffered, nothing touches disk.
 *
 * A turn is built up incrementally (a user utterance's routing decision arrives before, sometimes long
 * before, the Body's result for whatever it triggered) and flushed as a single JSON line by `finishTurn`.
 * Every setter is a safe no-op for a turnId that was never started (e.g. '' from a caller that has no turn
 * to attach to, such as an onChip-derived reply) or that already finished.
 */
export interface DecisionTrace {
  /** Starts a new turn; returns its turnId ('' when tracing is off — every other method treats '' as "no
   * turn", so callers never need to branch on whether tracing is enabled). */
  startTurn(utterance: { source: TraceSource; text: string }): string;
  setRoute(turnId: string, route: TraceRoute): void;
  addModelCall(turnId: string, call: TraceModelCall): void;
  setExtracted(turnId: string, extracted: TraceExtracted): void;
  setGate(turnId: string, gate: TraceGate): void;
  addSent(turnId: string, sent: TraceSent): void;
  addResult(turnId: string, result: TraceResult): void;
  /** Appends the turn's single JSON line (whatever fields were set so far) and forgets it. Safe to call
   * more than once, or on an unknown/empty turnId (no-op). */
  finishTurn(turnId: string): void;
  /** A standalone record for one unsolicited-nudge decider attempt — not tied to any user turn/turnId. */
  logNudgeDecision(record: TraceNudgeDecisionRecord): void;
  /** Force-flushes (with whatever was collected) any turn started more than `STALE_MS` ago — a safety net
   * against a turn that never reaches its natural finish (e.g. a lost correlation). Call periodically. */
  sweep(now: number): void;
}

const MAX_BYTES = 5 * 1024 * 1024;
/** How long a turn may sit half-built before `sweep` force-flushes it. */
const STALE_MS = 5 * 60_000;

interface TurnState {
  turnId: string;
  startedAt: number;
  utterance: { source: TraceSource; text: string };
  route?: TraceRoute;
  modelCalls: TraceModelCall[];
  extracted?: TraceExtracted;
  gate?: TraceGate;
  sent: TraceSent[];
  result?: TraceResult;
}

function turnLine(t: TurnState): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    turnId: t.turnId,
    utterance: t.utterance,
    ...(t.route ? { route: t.route } : {}),
    ...(t.modelCalls.length > 0 ? { model_call: t.modelCalls } : {}),
    ...(t.extracted ? { extracted: t.extracted } : {}),
    ...(t.gate ? { gate: t.gate } : {}),
    ...(t.sent.length > 0 ? { sent: t.sent } : {}),
    ...(t.result ? { result: t.result } : {}),
  });
}

/** Appends `line` to `path`, rotating the current file to `path.1` first when it's already at/over
 * MAX_BYTES (keeping exactly one rotated generation, overwriting any previous `.1`). */
function appendWithRotation(path: string, line: string): void {
  if (existsSync(path) && statSync(path).size >= MAX_BYTES) {
    renameSync(path, `${path}.1`);
  }
  appendFileSync(path, `${line}\n`);
}

export const noopTrace: DecisionTrace = {
  startTurn: () => '',
  setRoute: () => undefined,
  addModelCall: () => undefined,
  setExtracted: () => undefined,
  setGate: () => undefined,
  addSent: () => undefined,
  addResult: () => undefined,
  finishTurn: () => undefined,
  logNudgeDecision: () => undefined,
  sweep: () => undefined,
};

export interface FileTraceDeps {
  /** Directory brain.log itself lives in (`CocoPaths.logsDir` on the Body side) — trace.jsonl is written
   * alongside it. Created by the caller if it doesn't exist yet (main.ts already does this for dataDir; do
   * the same for logsDir before constructing this). */
  logsDir: string;
  clock: () => number;
  newId: () => string;
}

/** The real, file-backed implementation. Use `createDecisionTrace(config, deps)` rather than calling this
 * directly — it already picks this vs. `noopTrace` based on `config.debug.trace`. */
export function createFileTrace(deps: FileTraceDeps): DecisionTrace {
  const path = join(deps.logsDir, 'trace.jsonl');
  const turns = new Map<string, TurnState>();

  const flush = (t: TurnState): void => appendWithRotation(path, turnLine(t));

  return {
    startTurn(utterance) {
      const turnId = deps.newId();
      turns.set(turnId, { turnId, startedAt: deps.clock(), utterance, modelCalls: [], sent: [] });
      return turnId;
    },
    setRoute(turnId, route) {
      const t = turns.get(turnId);
      if (t) t.route = route;
    },
    addModelCall(turnId, call) {
      turns.get(turnId)?.modelCalls.push(call);
    },
    setExtracted(turnId, extracted) {
      const t = turns.get(turnId);
      if (t) t.extracted = extracted;
    },
    setGate(turnId, gate) {
      const t = turns.get(turnId);
      if (t) t.gate = gate;
    },
    addSent(turnId, sent) {
      turns.get(turnId)?.sent.push(sent);
    },
    addResult(turnId, result) {
      const t = turns.get(turnId);
      if (t) t.result = result;
    },
    finishTurn(turnId) {
      const t = turns.get(turnId);
      if (!t) return;
      turns.delete(turnId);
      flush(t);
    },
    logNudgeDecision(record) {
      appendWithRotation(path, JSON.stringify({ ts: new Date().toISOString(), type: 'nudge_decision', ...record }));
    },
    sweep(now) {
      for (const t of turns.values()) {
        if (now - t.startedAt >= STALE_MS) {
          turns.delete(t.turnId);
          flush(t);
        }
      }
    },
  };
}

/** Picks `createFileTrace` or `noopTrace` based on `enabled` (pass `config.debug.trace`) — the single
 * gate point so every call site can just always use whatever this returns. */
export function createDecisionTrace(enabled: boolean, deps: FileTraceDeps): DecisionTrace {
  if (!enabled) return noopTrace;
  mkdirSync(deps.logsDir, { recursive: true });
  return createFileTrace(deps);
}

