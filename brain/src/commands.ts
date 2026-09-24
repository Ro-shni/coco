export type Command = { type: 'focus'; target: string; kind: 'app' | 'window' };

const PREFIXES = ['hey ', 'coco,', 'coco:', 'coco', 'can you ', 'could you ', 'please '];
const VERBS = [
  'go back to',
  'go to',
  'back to',
  'switch over to',
  'switch to',
  'show me',
  'show',
  'bring up',
  'focus on',
  'focus',
  'jump to',
  'open',
];
const ARTICLES = ['the ', 'my '];
const SUFFIXES: Record<string, 'window' | 'app'> = { window: 'window', tab: 'window', app: 'app' };
const QUESTION_WORD = /^(what|why|how|where|when|who|which|me|it|this|that|something)(?:[^a-z]|$)/i;
const MAX_TARGET_WORDS = 6;
const MAX_TARGET_CHARS = 60;

/** Strips a matching prefix from the start of text (repeatedly, for stacked prefixes like "hey coco, "). */
function stripPrefixes(text: string, prefixes: readonly string[]): string {
  let s = text;
  for (;;) {
    const hit = prefixes.find((p) => s.startsWith(p));
    if (!hit) return s;
    s = s.slice(hit.length).trimStart();
  }
}

/** Strips a trailing "please" and trailing .!? punctuation, in either order. */
function stripTrailing(text: string): string {
  let out = text.trimEnd();
  for (;;) {
    const next = out.replace(/[.!?]+$/, '').replace(/\s+please$/i, '').trimEnd();
    if (next === out) return out;
    out = next;
  }
}

export function parseCommand(text: string): Command | null {
  const raw = text.trim();
  if (raw.includes('?') && !raw.endsWith('?')) return null;

  const s = stripPrefixes(stripTrailing(raw).toLowerCase(), PREFIXES);

  const verb = VERBS.find((v) => s === v || s.startsWith(`${v} `));
  if (!verb) return null;
  const rest = s.slice(verb.length).trimStart();
  if (!rest) return null;
  if (rest.split(/\s+/).length > MAX_TARGET_WORDS) return null;

  const words = stripPrefixes(rest, ARTICLES).split(/\s+/);
  let kind: 'app' | 'window' = 'app';
  const last = words.at(-1);
  if (last && last in SUFFIXES && words.length > 1) {
    kind = SUFFIXES[last]!;
    words.pop();
  }

  const target = words.join(' ').trim().replace(/^["'](.*)["']$/, '$1').trim();
  if (!target) return null;
  if (target.length > MAX_TARGET_CHARS) return null;
  if (QUESTION_WORD.test(target)) return null;
  if (target.includes('?') && !target.endsWith('?')) return null;

  return { type: 'focus', target, kind };
}
