import { z } from 'zod';

const OpenUrlAction = z.object({ open: z.literal('url'), url: z.string().min(1), label: z.string().min(1) });
const OpenAppAction = z.object({ open: z.literal('app'), target: z.string().min(1) });
const ModelActionSchema = z.discriminatedUnion('open', [OpenUrlAction, OpenAppAction]);

export type ModelAction = z.infer<typeof ModelActionSchema>;

export interface ExtractedAction {
  /** The reply with any ```action fenced block(s) removed, trimmed. */
  text: string;
  action: ModelAction | null;
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
  if (blocks.length === 0) return { text: reply.trim(), action: null };

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
    return { text, action: null };
  }
  const result = ModelActionSchema.safeParse(parsed);
  if (!result.success) return { text, action: null };
  if (result.data.open === 'url' && !isHttpOrHttps(result.data.url)) return { text, action: null };
  return { text, action: result.data };
}

/**
 * Security-critical gate: a model-proposed action may only be executed when the user's OWN utterance for
 * this turn asked for it. Never derived from screen/OCR text, and never applied to unsolicited nudges
 * (those never carry actions in the first place — see chat.ts, the only caller that extracts actions).
 */
const INTENT_WORDS = /\b(open|launch|start|play|search|show|go to|bring up|pull up|take me)\b/i;

export function intentAllowsAction(utterance: string): boolean {
  return INTENT_WORDS.test(utterance);
}
