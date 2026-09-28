import type { AutonomyMode } from '../connectors/types.js';

export interface AutonomyDecision {
  mode: AutonomyMode;
  reason: 'override' | 'read_default' | 'write_default' | 'untrusted_args';
}

const READ = /^(get|list|search|read|fetch|describe|query)/i;
const MIN_COPIED = 12;

export function defaultMode(toolName: string): AutonomyMode {
  return READ.test(toolName) ? 'auto' : 'confirm';
}

function stringsIn(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(stringsIn);
  if (v && typeof v === 'object') return Object.values(v).flatMap(stringsIn);
  return [];
}

/** True if some ≥MIN_COPIED-char window of an argument string appears verbatim (case-insensitive) in the untrusted text. */
function copiesUntrusted(args: Record<string, unknown>, untrusted: string): boolean {
  if (untrusted.length < MIN_COPIED) return false;
  const hay = untrusted.toLowerCase();
  return stringsIn(args).some((s) => {
    const v = s.toLowerCase();
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
