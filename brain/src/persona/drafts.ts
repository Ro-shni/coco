const MAX_DRAFT_CHARS = 4000;

/** A ```draft fenced block (preferred). Captures everything between the opening fence and the closing ```. */
const FENCED_DRAFT = /```draft[ \t]*\r?\n?([\s\S]*?)```/;
/** A line starting with "Draft:" — everything after it (rest of the line, plus any further lines) is the draft. */
const LINE_DRAFT = /^[ \t]*Draft:[ \t]?/im;
/** Coco claiming (in the non-draft text) that it wrote a draft — used to catch a claim with no matching draft block. */
const CLAIMS_DRAFT_EXISTS = /\b(i(?:'ve| have)?\s+)?drafted\b|\bhere(?:'s| is) (?:a|the|your) draft\b|\bdraft (?:is )?(?:ready|below)\b/i;

/** True when text asserts a draft was written (e.g. "I've drafted a reply", "here's a draft"). */
export function claimsDraftExists(text: string): boolean {
  return CLAIMS_DRAFT_EXISTS.test(text);
}

export interface ExtractedDraft {
  /** The reply with the draft block removed, trimmed. Any lead-in sentence (and trailing line, for the fenced form) is kept. */
  text: string;
  /** The drafted message, trimmed and capped at 4000 chars, or null when there was no draft or it was empty. */
  draft: string | null;
}

function normalizeDraft(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return trimmed.length > MAX_DRAFT_CHARS ? trimmed.slice(0, MAX_DRAFT_CHARS) : trimmed;
}

/** Joins the text surrounding a removed block, dropping either side if it is blank after trimming. */
function joinAround(before: string, after: string): string {
  const b = before.trim();
  const a = after.trim();
  if (b !== '' && a !== '') return `${b}\n${a}`;
  return b !== '' ? b : a;
}

/**
 * Splits a model reply into the spoken text and an optional draft message, recognising a
 * ```draft fenced block (preferred) or a "Draft:" line as the fallback format. See ExtractedDraft.
 */
export function extractDraft(reply: string): ExtractedDraft {
  const fenced = reply.match(FENCED_DRAFT);
  if (fenced && fenced.index !== undefined) {
    const draft = normalizeDraft(fenced[1] ?? '');
    const before = reply.slice(0, fenced.index);
    const after = reply.slice(fenced.index + fenced[0].length);
    return { text: joinAround(before, after), draft };
  }
  const line = reply.match(LINE_DRAFT);
  if (line && line.index !== undefined) {
    const before = reply.slice(0, line.index);
    const after = reply.slice(line.index + line[0].length);
    return { text: before.trim(), draft: normalizeDraft(after) };
  }
  return { text: reply.trim(), draft: null };
}
