import type { ToolInfo } from '../connectors/types.js';

export const MAX_TOOLS = 6;

const STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'what', 'whats', 's', 'of', 'for', 'to', 'in', 'on', 'me', 'my', 'i', 'you', 'your',
  'can', 'could', 'please', 'show', 'tell', 'and', 'or', 'it', 'this', 'that', 'with', 'from', 'about', 'haha', 'funny', 'be',
]);

const withSingular = (w: string): string[] => (w.endsWith('s') && w.length > 3 ? [w, w.slice(0, -1)] : [w]);

const splitIdent = (s: string): string[] =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).flatMap(withSingular);

/** Tie-break: prefer read-like tools, so "status of X" picks getX over createX. */
const READ_LIKE = /^(get|list|search|read|fetch|describe|query)/i;

const queryTokens = (q: string): string[] =>
  [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).flatMap(withSingular))];

export function narrowTools(query: string, tools: readonly ToolInfo[], max = MAX_TOOLS): ToolInfo[] {
  const q = queryTokens(query);
  if (q.length === 0) return [];
  const scored = tools.map((t) => {
    const nameToks = new Set(splitIdent(t.name));
    const descToks = new Set(splitIdent(t.description));
    const serverToks = new Set(splitIdent(t.serverId));
    let score = 0;
    for (const w of q) {
      if (nameToks.has(w)) score += 3;
      if (descToks.has(w)) score += 1;
      if (serverToks.has(w)) score += 2;
    }
    if (score > 0 && READ_LIKE.test(t.name)) score += 1;
    return { t, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.t.qualified.localeCompare(b.t.qualified))
    .slice(0, max)
    .map((s) => s.t);
}
