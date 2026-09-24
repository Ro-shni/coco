import type { SayKind } from '../protocol.js';

export const FILLER_PATTERNS: readonly RegExp[] = [
  /great question/i,
  /let me know if/i,
  /i hope this helps/i,
  /\bas an ai\b/i,
  /^(sure|certainly|absolutely|of course)\b[,!.]/i,
  /feel free to/i,
  /happy to help/i,
  /it (looks|seems) like there('s| is) (an|some) (error|issue|problem)\b/i,
];

const EMOJI = /\p{Extended_Pictographic}/u;

const OUTWARD_ACTION =
  "sent|posted|replied|messaged|emailed|dm'?d|dm'?ed|approved|merged|deployed|scheduled|submitted|clicked|typed|pressed|created (?:a|the) (?:pr|ticket|issue)|opened (?:a|the) (?:pr|ticket)";
/** "I sent", "I've posted", "I have just merged" — Coco claiming it did the thing. */
const FIRST_PERSON_ACTION = new RegExp(`\\bi(?:'ve| have)?\\s+(?:just\\s+|already\\s+|also\\s+)?(?:${OUTWARD_ACTION})\\b`, 'i');
/** A clause that opens with a bare completion: "Sent to Prince.", "Done — approved." */
const BARE_COMPLETION = /^(?:(?:ok(?:ay)?|alright|all right|yep|great|and|so)[,!]?\s+)?(sent|posted|replied|done|approved|merged|submitted)\b/i;
const NEGATION = /\b(?:can't|cannot|can not|couldn't|could not|didn't|did not|won't|will not|haven't|have not|not|never|unable to|no way to)\b/i;
/** Quoted text is usually a draft for the user ("Here's a draft: \"Approved, go ahead.\""), not a claim. */
const QUOTED = /"[^"]*"|“[^”]*”|`[^`]*`/g;

/**
 * Returns the matched phrase when the text asserts, in first person or as a bare completion,
 * an outward action Coco cannot perform (sending, posting, approving, clicking...). Negated
 * clauses ("I can't send") and other subjects ("Prince sent", "was sent by") are not claims.
 */
export function claimsUnperformedAction(text: string): string | null {
  const clean = text.replace(/[‘’]/g, "'").replace(QUOTED, ' ');
  for (const sentence of clean.split(/(?<=[.!?])\s+|\n+/)) {
    const isQuestion = sentence.trim().endsWith('?');
    for (const raw of sentence.split(/[.!?;:—–]+|\s-\s/)) {
      const clause = raw.trim();
      const first = clause.match(FIRST_PERSON_ACTION);
      if (first && !NEGATION.test(clause.slice(0, first.index))) return first[0];
      const bare = isQuestion ? null : clause.match(BARE_COMPLETION);
      if (bare) return bare[0].slice(bare[0].length - bare[1]!.length);
    }
  }
  return null;
}

export interface CheckInput {
  text: string;
  kind: SayKind;
  incidentMode: boolean;
  maxSentences: number;
}

export function countSentences(text: string): number {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s)).length;
}

export function checkReply(input: CheckInput): { ok: boolean; problems: string[] } {
  const text = input.text.trim();
  const problems: string[] = [];
  if (text === '') problems.push('empty reply');
  for (const pattern of FILLER_PATTERNS) {
    const match = text.match(pattern);
    if (match) problems.push(`filler phrase: "${match[0]}"`);
  }
  const sentences = countSentences(text);
  if (sentences > input.maxSentences) problems.push(`too long: ${sentences} sentences (max ${input.maxSentences})`);
  if ((text.match(/!/g) ?? []).length > 1) problems.push('too many exclamation marks (be dry, not dramatic)');
  const claim = claimsUnperformedAction(text);
  if (claim) {
    problems.push(`claims an action you did not perform: "${claim}" — you cannot send, post, click, type, approve or merge; say so and offer a draft instead`);
  }
  if (input.incidentMode && input.kind === 'quip') problems.push('no jokes during an incident');
  if (input.incidentMode && EMOJI.test(text)) problems.push('no emoji during an incident');
  return { ok: problems.length === 0, problems };
}
