import type { AutonomyMode } from '../connectors/types.js';

export interface AutonomyDecision {
  mode: AutonomyMode;
  reason: 'override' | 'read_default' | 'write_default' | 'untrusted_args';
}

export const READ = /^(get|list|search|read|fetch|describe|query)/i;
const MIN_COPIED = 12;

const WRITE_VERBS = new Set([
  'delete', 'remove', 'purge', 'drop', 'destroy', 'create', 'update', 'write', 'send', 'post', 'put', 'set',
  'run', 'exec', 'execute', 'kill', 'restart', 'scale', 'apply', 'patch', 'move', 'rename', 'approve',
  'merge', 'deploy', 'rollback', 'cancel', 'close', 'archive',
]);

const splitIdent = (s: string): string[] =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export function defaultMode(toolName: string): AutonomyMode {
  // If ANY token is a write verb, return 'confirm' even with a read prefix
  const tokens = splitIdent(toolName);
  if (tokens.some((t) => WRITE_VERBS.has(t))) return 'confirm';
  return READ.test(toolName) ? 'auto' : 'confirm';
}

function stringsIn(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(stringsIn);
  if (v && typeof v === 'object') return Object.values(v).flatMap(stringsIn);
  return [];
}

/** Normalize to lowercase alphanumerics only (strip spaces, punctuation, underscores, hyphens). */
function normalizeToAlphanumeric(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True if some ≥MIN_COPIED-alphanumeric-char window of an argument string appears in the untrusted text (after alphanumeric normalization). */
function copiesUntrusted(args: Record<string, unknown>, untrusted: string): boolean {
  const hay = normalizeToAlphanumeric(untrusted);
  if (hay.length < MIN_COPIED) return false;
  return stringsIn(args).some((s) => {
    const v = normalizeToAlphanumeric(s);
    for (let i = 0; i + MIN_COPIED <= v.length; i++) if (hay.includes(v.slice(i, i + MIN_COPIED))) return true;
    return false;
  });
}

export function decide(input: {
  qualified: string;
  toolName: string;
  args: Record<string, unknown>;
  override?: AutonomyMode;
  untrustedText: string;
}): AutonomyDecision {
  if (input.override === 'off') return { mode: 'off', reason: 'override' };
  if (copiesUntrusted(input.args, input.untrustedText)) return { mode: 'confirm', reason: 'untrusted_args' };
  if (input.override) return { mode: input.override, reason: 'override' };
  const mode = defaultMode(input.toolName);
  return { mode, reason: mode === 'auto' ? 'read_default' : 'write_default' };
}
