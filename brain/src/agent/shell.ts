import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import type { ToolResult } from '../connectors/manager.js';
import type { ToolInfo } from '../connectors/types.js';

/** Coco's built-in terminal tool: one shell command per call, run as the user in zsh. */
export const SHELL_SERVER_ID = 'coco';
export const SHELL_TOOL_NAME = 'shell_run';
export const SHELL_QUALIFIED = `${SHELL_SERVER_ID}__${SHELL_TOOL_NAME}`;

export type ShellMode = 'auto' | 'confirm' | 'block';
export interface ShellPolicy { mode: ShellMode; reason: string }

const MAX_COMMAND_CHARS = 2000;
const MAX_OUTPUT_CHARS = 4000;
const TRUNC = '…[truncated]';
const DEFAULT_TIMEOUT_MS = 20_000;

/** Anything that chains, substitutes, redirects or escapes (only used to label a command read-only). */
const SHELL_META = /[;&|`$<>(){}\\\n\r]/;

/** The user's rule: everything runs freely except deleting or destroying things, which asks first. */
const DESTRUCTIVE: RegExp[] = [
  /(^|[\s;&|(`])(rm|rmdir|unlink|srm|shred|truncate)(\s|$)/,
  /\bfind\b[^;|&]*(-delete\b|-exec(dir)?\s+(rm|unlink|shred)\b)/,
  /\bgit\s+(clean\b|reset\s+--hard\b|branch\s+(-D|--delete)\b|stash\s+(drop|clear)\b|checkout\s+--\s|restore\b)/,
  /\bgit\s+push\b[^;|&]*\s(--force(-with-lease)?|-f)\b/,
  /(^|[\s;&|])(kill|pkill|killall)(\s|$)/,
  /\b(kubectl|helm|docker|podman|brew|npm|pnpm|yarn|pip3?|gcloud|gsutil|terraform|aws|gh)\b[^;|&]*\s(delete|uninstall|remove|rm|rmi|un|prune|purge|destroy)(\s|$)/,
  /\bdrop\s+(table|database|schema|index|user)\b/i,
  /\b(delete\s+from|truncate\s+table)\b/i,
  /(^|[^>&0-9])>(?![>&|])\s*(?!\/dev\/null)[^\s>]/, // `> file` overwrites (>> appends; 2>&1 and >/dev/null are fine)
  /(^|\s)\d>(?![>&])\s*(?!\/dev\/null)[^\s>]/,
];

const BLOCKED: { re: RegExp; reason: string }[] = [
  { re: /(^|[\s;&|(`])sudo(\s|$)/, reason: 'sudo is never allowed' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|perl|ruby|node)\b/, reason: 'piping a download into a shell' },
  { re: /\bmkfs(\.\w+)?\b/, reason: 'formatting a disk' },
  { re: /\bdd\b[^|;&]*\bof=\/dev\//, reason: 'writing to a raw device' },
  { re: /:\(\)\s*\{/, reason: 'fork bomb' },
  { re: /(^|[\s;&|])(shutdown|reboot|halt)(\s|$)/, reason: 'shutting the Mac down' },
  { re: /\bdiskutil\s+(erase\w*|zero\w*|partition\w*)/i, reason: 'erasing a disk' },
  { re: /\b(int|prd)\.(meesho|mrouter)\.int\b/i, reason: 'production hosts are off limits' },
  { re: /\b(kubectl|helm)\b.*--(kube-)?context[=\s]+\S*(prd|prod)\S*/i, reason: 'production Kubernetes contexts are off limits' },
];

/** rm with both -r and -f aimed at / or the home folder. */
function isWipe(command: string): boolean {
  for (const segment of command.split(/[;&|]+/)) {
    const words = segment.trim().split(/\s+/);
    if (words[0] !== 'rm') continue;
    const flags = words.filter((w) => w.startsWith('-')).join('');
    if (!/r/i.test(flags) || !/f/.test(flags)) continue;
    const targets = words.slice(1).filter((w) => !w.startsWith('-'));
    if (targets.some((t) => ['/', '/*', '~', '~/', '~/*', '$HOME', '"$HOME"', '$HOME/', '/Users', '/System'].includes(t))) return true;
  }
  return false;
}

/** Splits on whitespace, keeping simple single/double-quoted words together (no escapes — those are SHELL_META). */
function words(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

const READ_ONLY = new Set(['ps', 'pgrep', 'ls', 'pwd', 'whoami', 'uptime', 'df', 'du', 'top', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'git', 'node', 'which']);
const GIT_READ = new Set(['status', 'log', 'diff', 'branch', 'show']);
const FIND_WRITES = new Set(['-exec', '-execdir', '-delete', '-ok', '-okdir', '-fprint', '-fprintf', '-fls']);

function readOnlyCheck(w: string[]): boolean {
  const [cmd, sub] = w;
  if (!cmd || !READ_ONLY.has(cmd)) return false;
  if (cmd === 'find') return !w.some((x) => FIND_WRITES.has(x));
  if (cmd === 'git') return sub !== undefined && GIT_READ.has(sub) && !(sub === 'branch' && w.some((x) => /^-[dDmMcC]$|^--(delete|move|copy)/.test(x)));
  if (cmd === 'top') return w.includes('-l');
  if (cmd === 'node') return w.length === 2 && (sub === '-v' || sub === '--version');
  return true;
}

/** Decides whether a command may run immediately, needs the user's click, or is refused outright. */
export function classifyCommand(command: string): ShellPolicy {
  const c = command.trim();
  if (c === '') return { mode: 'block', reason: 'empty command' };
  if (c.length > MAX_COMMAND_CHARS) return { mode: 'block', reason: 'command too long' };
  for (const b of BLOCKED) if (b.re.test(c)) return { mode: 'block', reason: b.reason };
  if (isWipe(c)) return { mode: 'block', reason: 'deleting / or your home folder' };
  if (DESTRUCTIVE.some((re) => re.test(c))) return { mode: 'confirm', reason: 'deletes or destroys something' };
  return !SHELL_META.test(c) && readOnlyCheck(words(c)) ? { mode: 'auto', reason: 'read-only command' } : { mode: 'auto', reason: 'not a delete' };
}

const truncate = (s: string): string => (s.length <= MAX_OUTPUT_CHARS ? s : s.slice(0, MAX_OUTPUT_CHARS - TRUNC.length) + TRUNC);

/** Runs one command in zsh (no rc files) in its own process group, so a timeout kills everything it started. */
export function runShell(opts: { command: string; cwd: string; timeoutMs?: number }): Promise<ToolResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('/bin/zsh', ['-f', '-c', opts.command], { cwd: opts.cwd, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const collect = (d: Buffer) => {
      if (out.length <= MAX_OUTPUT_CHARS * 2) out += d.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `error: ${err.message}`, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const body = out.replace(/\n$/, '');
      if (timedOut) return resolve({ ok: false, text: truncate(`timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms\n${body}`), ms: Date.now() - started });
      resolve({ ok: code === 0, text: truncate(`exit ${code ?? 1}\n${body}`), ms: Date.now() - started });
    });
  });
}

export class ShellTool {
  readonly info: ToolInfo = {
    serverId: SHELL_SERVER_ID,
    name: SHELL_TOOL_NAME,
    qualified: SHELL_QUALIFIED,
    description:
      'Run a terminal (shell) command on this Mac and read its output: check running processes, terminals, files, folders, logs, disk space, git, builds, tests. Commands run immediately; only deleting or destroying something needs the user to confirm. Never use this to start Claude, Claude Code or a skill — use coco__claude_code for that.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'One zsh command, e.g. "pgrep -fl claude" or "git status"' },
        cwd: { type: 'string', description: 'Absolute folder to run in (default: home folder)' },
      },
      required: ['command'],
    },
  };

  constructor(private readonly deps: { clock: () => number; timeoutMs?: number }) {}

  policy(args: Record<string, unknown>): ShellPolicy {
    if (typeof args.command !== 'string') return { mode: 'block', reason: 'no command given' };
    if (args.cwd !== undefined) {
      const cwd = args.cwd;
      if (typeof cwd !== 'string' || !isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
        return { mode: 'block', reason: 'cwd must be an existing absolute folder' };
      }
    }
    return classifyCommand(args.command);
  }

  async call(args: Record<string, unknown>): Promise<ToolResult> {
    const p = this.policy(args);
    if (p.mode === 'block') return { ok: false, text: `blocked: ${p.reason}`, ms: 0 };
    return runShell({ command: args.command as string, cwd: (args.cwd as string | undefined) ?? homedir(), timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  }
}
