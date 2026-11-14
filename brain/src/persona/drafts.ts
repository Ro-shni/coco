const MAX_DRAFT_CHARS = 4000;

/** A closed ```draft fenced block (preferred). Global: a reply may contain more than one. */
const FENCED_DRAFT = /```draft[ \t]*\r?\n?([\s\S]*?)```/g;
/** An unclosed ```draft fence (no closing ```): everything after it, to the end of the reply, is the draft. */
const UNCLOSED_FENCED_DRAFT = /```draft[ \t]*\r?\n?([\s\S]*)$/;
/** A line starting with "Draft:" — everything after it (rest of the line, plus any further lines) is the draft. */
const LINE_DRAFT = /^[ \t]*Draft:[ \t]?/im;
/** Coco claiming (in the non-draft text) that it wrote a draft — used to catch a claim with no matching draft block. */
const CLAIMS_DRAFT_EXISTS = /\b(i(?:'ve| have)?\s+)?drafted\b|\bhere(?:'s| is) (?:a|the|your) draft\b|\bdraft (?:is )?(?:ready|below)\b/i;

/** True when text asserts a draft was written (e.g. "I've drafted a reply", "here's a draft"). */
export function claimsDraftExists(text: string): boolean {
  return CLAIMS_DRAFT_EXISTS.test(text);
}

export interface ExtractedDraft {
  /** The reply with the draft block(s) removed, trimmed. Any lead-in/trailing text is kept; raw ```draft markup never survives into this field. */
  text: string;
  /** The drafted message, trimmed and capped at 4000 chars, or null when there was no draft or it was empty. */
  draft: string | null;
}

function normalizeDraft(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return trimmed.length > MAX_DRAFT_CHARS ? trimmed.slice(0, MAX_DRAFT_CHARS) : trimmed;
}

/** Joins the non-blank segments left after removing one or more blocks from a reply. */
function joinSegments(segments: readonly string[]): string {
  return segments
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .join('\n');
}

/**
 * Splits a model reply into the spoken text and an optional draft message. Recognises, in priority order:
 * one or more closed ```draft fenced blocks (the first is the draft; all are stripped from the text), an
 * unclosed ```draft fence (everything after it, to the end, is the draft — or the bare marker is stripped
 * if that's empty), or a "Draft:" line (fallback format). See ExtractedDraft.
 */
export function extractDraft(reply: string): ExtractedDraft {
  const closed = [...reply.matchAll(FENCED_DRAFT)];
  if (closed.length > 0) {
    const draft = normalizeDraft(closed[0]![1] ?? '');
    const segments: string[] = [];
    let cursor = 0;
    for (const m of closed) {
      segments.push(reply.slice(cursor, m.index));
      cursor = m.index! + m[0].length;
    }
    segments.push(reply.slice(cursor));
    return { text: joinSegments(segments), draft };
  }

  const unclosed = reply.match(UNCLOSED_FENCED_DRAFT);
  if (unclosed && unclosed.index !== undefined) {
    const draft = normalizeDraft(unclosed[1] ?? '');
    return { text: reply.slice(0, unclosed.index).trim(), draft };
  }

  const line = reply.match(LINE_DRAFT);
  if (line && line.index !== undefined) {
    const before = reply.slice(0, line.index);
    const after = reply.slice(line.index + line[0].length);
    return { text: before.trim(), draft: normalizeDraft(after) };
  }

  return { text: reply.trim(), draft: null };
}
