import { z } from 'zod';

/** Caps mirror (or are tighter than) the protocol-level limits (FocusMsg.target, OpenUrlMsg.url) so a
 * schema mismatch is caught HERE — action rejected, no pending state ever created — instead of surfacing
 * later as a throw from `encodeBrainMessage` after the orchestrator has already started tracking it. */
const OpenUrlAction = z.object({ open: z.literal('url'), url: z.string().min(1).max(2048), label: z.string().min(1).max(80) });
const OpenAppAction = z.object({ open: z.literal('app'), target: z.string().min(1).max(120) });
const ModelActionSchema = z.discriminatedUnion('open', [OpenUrlAction, OpenAppAction]);

export type ModelAction = z.infer<typeof ModelActionSchema>;

export interface ExtractedAction {
  /** The reply with any ```action fenced block(s) removed, trimmed. */
  text: string;
  action: ModelAction | null;
  /** True when a ```action fenced block was present at all, regardless of whether it validated — distinct
   * from `action` being null, which is also what a reply with NO block looks like. A caller that needs to
   * know "was something proposed that then got rejected?" (chat.ts's I2 fix) checks this, not `action`. */
  blockPresent: boolean;
}

/** A closed ```action fenced block. Global: a reply may (wrongly) contain more than one — only the first is
 * ever used as the action; all are stripped from the text. */
const ACTION_BLOCK = /```action[ \t]*\r?\n([\s\S]*?)```/g;

function isHttpOrHttps(url: string): boolean {
  try {
    const scheme = new URL(url).protocol;
    return scheme === 'http:' || scheme === 'https:';
  } catch {
    return false;
  }
}

/**
 * Splits a model reply into the spoken text and at most one proposed action (opening a URL or launching an
 * app), read from a ```action fenced JSON block. Malformed JSON, a schema mismatch, or a non-http(s) URL
 * all yield a null action — the block is still stripped from the text either way.
 */
export function extractAction(reply: string): ExtractedAction {
  const blocks = [...reply.matchAll(ACTION_BLOCK)];
  if (blocks.length === 0) return { text: reply.trim(), action: null, blockPresent: false };

  const segments: string[] = [];
  let cursor = 0;
  for (const m of blocks) {
    segments.push(reply.slice(cursor, m.index));
    cursor = m.index! + m[0].length;
  }
  segments.push(reply.slice(cursor));
  const text = segments
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .join('\n');

  let parsed: unknown;
  try {
    parsed = JSON.parse(blocks[0]![1]!.trim());
  } catch {
    return { text, action: null, blockPresent: true };
  }
  const result = ModelActionSchema.safeParse(parsed);
  if (!result.success) return { text, action: null, blockPresent: true };
  if (result.data.open === 'url' && !isHttpOrHttps(result.data.url)) return { text, action: null, blockPresent: true };
  return { text, action: result.data, blockPresent: true };
}

/**
 * Security-critical gate: a model-proposed action may only be executed when the user's OWN utterance for
 * this turn asked for it — imperatively — never derived from screen/OCR text, never satisfied by a chip
 * click (chat.ts strips action blocks outright on those turns; see orchestrator.ts C1), and never applied
 * to unsolicited nudges (those never carry actions in the first place — chat.reply is only ever called for
 * a user utterance or, without an intent, a chip-derived reply).
 *
 * An action verb merely appearing somewhere in the sentence is not enough (that was the injection-prone
 * version of this gate): it must be imperative — at the very start of a clause, or immediately after an
 * allowed lead-in ("can/could/would you (please)", "please", "I want you to") — and the clause must not be
 * a wh-question ("what does this show?", "where do I start?"), even when it mentions a verb from the list.
 */
const ADDRESS_PREFIX = /^(?:hey\s+)?coco[,:]?\s*/i;
const LEAD_IN = /^(?:(?:can|could|would)\s+you\s+(?:please\s+)?|please\s+|i\s+want\s+you\s+to\s+)/i;
const ACTION_VERB_AT_START = /^(?:open|launch|start|play|search|show|go\s+to|bring\s+up|pull\s+up|take\s+me)\b/i;
const WH_QUESTION = /^(?:what|why|how|where|when|who|which)\b.*\?\s*$/i;

export function intentAllowsAction(utterance: string): boolean {
  const clauses = utterance
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((c) => c !== '');
  return clauses.some((rawClause) => {
    const clause = rawClause.trim().replace(ADDRESS_PREFIX, '');
    if (WH_QUESTION.test(clause)) return false;
    return ACTION_VERB_AT_START.test(clause.replace(LEAD_IN, ''));
  });
}
