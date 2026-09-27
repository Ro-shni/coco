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

const COMPLETION_VERB =
  "sent|posted|replied|messaged|emailed|dm'?e?d|approved|merged|deployed|scheduled|submitted|clicked|typed|pressed|shared|forwarded|pinged|notified|delivered|created (?:a|the) (?:pr|ticket|issue)|opened|launched";
const ADVERB = '(?:just|already|also|now|ok(?:ay)?|alright|all right|great|and|so|yep|done)';
const LEAD = `(?:${ADVERB}[,!]?\\s+)*`;
/** Things Coco might claim to have sent: "it", "that", "all", "your message", "the reply"... */
const SUBJECT = "(?:it|that|this|all|everything|(?:the|your|my)?\\s*(?:message|reply|approval|draft|response|dm|email|note|pr|comment|update)s?)";
const AUX = "(?:'s been|'s|\\s+(?:is|was|are|were|got|has been|have been))";
/** Verbs whose "to X" names a recipient ("Sent to Prince"); for the rest "to X" is a place ("Deployed to prd"). */
const SEND_VERB = "sent|posted|replied|messaged|emailed|dm'?e?d|forwarded|shared|pinged|notified|delivered";
/** What may follow a bare participle: clause end (or trailing punctuation/emoji), or an object or particle. */
const OBJECT_FOLLOW = "\\s*(?:$|[^\\w\\s])|\\s+(?:it|that|them|this|the (?:message|reply|draft|approval|note|dm)|over|off|through|across)\\b";
const SEND_FOLLOW = `(?=${OBJECT_FOLLOW}|\\s+to\\s+\\S)`;
const BARE_FOLLOW = `(?=${OBJECT_FOLLOW})`;
const CLAIM_FORMS: readonly { form: RegExp; inQuestions: boolean }[] = [
  // (a) first person: "I sent", "I've just replied", "We've pinged"
  { form: new RegExp(`\\b(?:i|we)(?:'ve|'d| have| had)?\\s+(?:${ADVERB}\\s+)*(?:${COMPLETION_VERB})\\b`, 'i'), inQuestions: true },
  // (b) passive/stative about the thing: "It's sent", "Message sent to Prince", "Your message has been sent" (not "... sent by pagerduty")
  { form: new RegExp(`^${LEAD}${SUBJECT}${AUX}?\\s+(?:${ADVERB}\\s+)*(?:${COMPLETION_VERB})\\b(?!\\s+by\\b)`, 'i'), inQuestions: true },
  // (c)/(d) bare or elliptical completion at clause start: "Sent to Prince", "Just sent it over", "Done, posted it", "Approved ✅"
  // Only when the participle ends the clause or takes an object/recipient/particle, so factual
  // nudges ("Deployed at 10:38", "Merged 20 minutes ago", "Approved by Prince") are not claims.
  // "to X" counts as a recipient only for send-family verbs: "Sent to Prince" yes, "Deployed to prd at 10:38" no.
  { form: new RegExp(`^${LEAD}(?:${SEND_VERB})${SEND_FOLLOW}`, 'i'), inQuestions: false },
  { form: new RegExp(`^${LEAD}(?:${COMPLETION_VERB})${BARE_FOLLOW}`, 'i'), inQuestions: false },
  // (e) a clause that is just "Done"
  { form: /^done[!.]*$/i, inQuestions: false },
];
const NEGATION =
  /\b(?:can't|cannot|can not|couldn't|could not|didn't|did not|won't|will not|haven't|have not|hasn't|has not|isn't|wasn't|not|never|nothing|nobody|no one|unable to|no way to)\b/i;
/** Drafts for the user (fenced blocks, quotes) are not claims: "```draft\nSent from my phone\n```". */
const DRAFTS = /```[\s\S]*?(?:```|$)|"[^"]*"|“[^”]*”|`[^`]*`/g;

/**
 * Returns the matched phrase when any clause asserts that an outward action (sending, posting,
 * approving, clicking...) is complete, in first person, passive/stative or bare form. Negated
 * clauses ("It hasn't been sent"), third-party subjects ("Prince sent", "sent by pagerduty"),
 * bare forms in questions ("Approved?") and drafted text are not claims.
 */
export function claimsUnperformedAction(text: string): string | null {
  const clean = text.replace(/[‘’]/g, "'").replace(DRAFTS, ' ');
  for (const sentence of clean.split(/(?<=[.!?])\s+|\n+/)) {
    const isQuestion = sentence.trim().endsWith('?');
    for (const raw of sentence.split(/[.!?;:—–]+|\s-\s/)) {
      const clause = raw.trim();
      for (const { form, inQuestions } of CLAIM_FORMS) {
        if (isQuestion && !inQuestions) continue;
        const hit = clause.match(form);
        if (hit && !NEGATION.test(clause.slice(0, hit.index! + hit[0].length))) return hit[0].trim();
      }
    }
  }
  return null;
}

/** Progressive ("in-flight") verbs Coco might use while an action block is still pending confirmation from
 * the body — "Opening YouTube for you now.", "Pulling that up.". These are not completion claims (the
 * verb is progressive, not past-tense), so `claimsUnperformedAction` never flags them — but they still say
 * something is happening when, if the action was dropped, nothing is. */
const PENDING_ACTION =
  /\b(?:opening|launching|searching|starting|playing)\b(?:\s+\S+){0,4}\s+(?:for you|now|up)\b|\b(?:pulling|bringing)\s+(?:it|that|this)\s+up\b/i;

/**
 * True when text implies an open/launch is in progress right now. Used only when a model action was
 * present in the reply but did not survive (gate rejection or schema mismatch) — in that case, a leftover
 * "Opening…"/"Pulling that up" line would be an honesty failure (nothing is actually opening), even though
 * it is not a *completion* claim `claimsUnperformedAction` would catch.
 */
export function claimsPendingAction(text: string): boolean {
  const clean = text.replace(/[‘’]/g, "'").replace(DRAFTS, ' ');
  return clean
    .split(/(?<=[.!?])\s+|\n+/)
    .some((sentence) => PENDING_ACTION.test(sentence) && !NEGATION.test(sentence.slice(0, sentence.search(PENDING_ACTION) + 1)));
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
