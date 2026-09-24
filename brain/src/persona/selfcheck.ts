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
  if (input.incidentMode && input.kind === 'quip') problems.push('no jokes during an incident');
  if (input.incidentMode && EMOJI.test(text)) problems.push('no emoji during an incident');
  return { ok: problems.length === 0, problems };
}
