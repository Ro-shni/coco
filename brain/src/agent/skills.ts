import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';

/** An installed Claude Code skill or command, with the slash name used to invoke it. */
export interface InstalledSkill {
  command: string;      // e.g. "/meesho-devops-rca:devops-rca" or "/api-design"
  name: string;
  plugin?: string;
  description: string;
  kind: 'skill' | 'command';
}

/** A plugin offered by a known marketplace but not installed. */
export interface InstallablePlugin {
  name: string;
  marketplace: string;
  description: string;
  install: string;      // the Claude Code command that installs it
}

const STOP = new Set([
  'the', 'a', 'an', 'in', 'on', 'of', 'for', 'to', 'and', 'or', 'is', 'it', 'this', 'that', 'my', 'me', 'you', 'your', 'can', 'please',
  'run', 'invoke', 'use', 'start', 'open', 'claude', 'code', 'skill', 'skills', 'terminal', 'with', 'what', 'why', 'how', 'haha', 'are', 'funny',
  'help', 'do', 'some', 'up', 'turn', 'plot', 'check', 'see', 'find', 'get', 'show', 'look', 'tell', 'about', 'there', 'any', 'have', 'need', 'want',
]);

const tokens = (s: string): string[] =>
  s.toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP.has(t));

function levenshtein(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]!;
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length]!;
}

/** 0..1 string similarity, tolerant of speech-recognition misspellings ("misho" ≈ "meesho"). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  if (Math.min(a.length, b.length) >= 4 && (b.startsWith(a) || a.startsWith(b))) return Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.25;
  // Short acronyms misheard by speech ("rcsq" for "rca"): same first two letters and nearly the same length.
  if (Math.max(a.length, b.length) <= 4 && a.slice(0, 2) === b.slice(0, 2) && Math.abs(a.length - b.length) <= 1) return 0.6;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function frontMatter(path: string): Record<string, unknown> {
  try {
    const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path, 'utf8'));
    return m ? ((parse(m[1]!) as Record<string, unknown> | null) ?? {}) : {};
  } catch {
    return {};
  }
}

const dirs = (p: string): string[] => {
  try {
    return readdirSync(p).filter((d) => statSync(join(p, d)).isDirectory());
  } catch {
    return [];
  }
};

const oneLine = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/** Scans ~/.claude for installed skills/commands and known marketplaces for plugins that could be installed. */
export class SkillCatalog {
  private skills: InstalledSkill[] = [];
  private offers: InstallablePlugin[] = [];

  constructor(private readonly opts: { home: string }) {}

  installed(): InstalledSkill[] { return [...this.skills]; }
  installable(): InstallablePlugin[] { return [...this.offers]; }

  refresh(): void {
    const claude = join(this.opts.home, '.claude');
    const found: InstalledSkill[] = [];
    for (const d of dirs(join(claude, 'skills'))) {
      const fm = frontMatter(join(claude, 'skills', d, 'SKILL.md'));
      const name = oneLine(fm.name) || d;
      found.push({ command: `/${name}`, name, description: oneLine(fm.description), kind: 'skill' });
    }
    const installedNames = new Set<string>();
    try {
      const raw = JSON.parse(readFileSync(join(claude, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, { installPath?: string }[]> };
      for (const [key, entries] of Object.entries(raw.plugins ?? {})) {
        const plugin = key.split('@')[0]!;
        installedNames.add(key);
        const path = entries?.[0]?.installPath;
        if (!path || !existsSync(path)) continue;
        for (const d of dirs(join(path, 'skills'))) {
          const fm = frontMatter(join(path, 'skills', d, 'SKILL.md'));
          const name = oneLine(fm.name) || d;
          found.push({ command: `/${plugin}:${name}`, name, plugin, description: oneLine(fm.description), kind: 'skill' });
        }
        let cmds: string[] = [];
        try { cmds = readdirSync(join(path, 'commands')).filter((f) => f.endsWith('.md')); } catch { /* none */ }
        for (const f of cmds) {
          const name = basename(f, '.md');
          found.push({ command: `/${plugin}:${name}`, name, plugin, description: oneLine(frontMatter(join(path, 'commands', f)).description), kind: 'command' });
        }
      }
    } catch {
      /* no plugins installed */
    }
    const seen = new Set<string>();
    this.skills = found.filter((s) => !seen.has(s.command) && seen.add(s.command));

    const offers: InstallablePlugin[] = [];
    for (const m of dirs(join(claude, 'plugins', 'marketplaces'))) {
      try {
        const mk = JSON.parse(readFileSync(join(claude, 'plugins', 'marketplaces', m, '.claude-plugin', 'marketplace.json'), 'utf8')) as { name?: string; plugins?: { name?: string; description?: string }[] };
        const market = mk.name ?? m;
        for (const p of mk.plugins ?? []) {
          if (!p.name || installedNames.has(`${p.name}@${market}`)) continue;
          offers.push({ name: p.name, marketplace: market, description: oneLine(p.description), install: `/plugin install ${p.name}@${market}` });
        }
      } catch {
        /* unreadable marketplace */
      }
    }
    const seenOffer = new Set<string>();
    this.offers = offers.filter((o) => !seenOffer.has(o.install) && seenOffer.add(o.install));
  }

  private score(query: string[], name: string, description: string): number {
    const nameToks = tokens(name);
    const descToks = [...new Set(tokens(description))];
    let s = 0;
    for (const q of query) {
      const best = Math.max(0, ...nameToks.map((n) => similarity(q, n)));
      if (best >= 0.6) s += 3 * best;
      else if (descToks.some((d) => similarity(q, d) >= 0.8)) s += 1;
    }
    return s;
  }

  /** Installed skills/commands that best match what the user said (top `k`, score ≥ 2). */
  search(query: string, k = 5): InstalledSkill[] {
    const q = tokens(query);
    if (q.length === 0) return [];
    return this.skills
      .map((s) => ({ s, score: this.score(q, `${s.plugin ?? ''} ${s.name}`, s.description) + (s.kind === 'skill' ? 0.1 : 0) - (/setup/.test(s.name) ? 0.5 : 0) }))
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map((x) => x.s);
  }

  /** Corrects a leading slash command to the closest installed one ("/mesho-devops-rca:devops-rca" →
   * "/meesho-devops-rca:devops-rca"); returns the task unchanged when it already matches or nothing is close. */
  canonicalizeTask(task: string): string {
    const m = /^\s*(\/[\w.-]+(?::[\w.-]+)?)(.*)$/s.exec(task);
    if (!m) return task;
    const cmd = m[1]!;
    if (this.skills.some((s) => s.command === cmd)) return task;
    let best: { command: string; sim: number } | undefined;
    for (const s of this.skills) {
      const sim = similarity(cmd.toLowerCase(), s.command.toLowerCase());
      if (!best || sim > best.sim) best = { command: s.command, sim };
    }
    return best && best.sim >= 0.8 ? `${best.command}${m[2]}` : task;
  }

  /** Installed matches plus installable plugins that match, for "is there a skill for X?". */
  suggest(query: string): { installed: InstalledSkill[]; installable: InstallablePlugin[] } {
    const q = tokens(query);
    const installed = this.search(query);
    if (installed.length > 0) return { installed, installable: [] };
    const installable = q.length === 0 ? [] : this.offers
      .map((p) => ({ p, score: this.score(q, p.name, p.description) }))
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((x) => x.p);
    return { installed, installable };
  }
}

export const FIND_SKILLS_QUALIFIED = 'coco__find_skills';

/** Built-in tool: which Claude skills are installed (or installable) for a request. Read-only, runs freely. */
export class FindSkillsTool {
  readonly info = {
    serverId: 'coco',
    name: 'find_skills',
    qualified: FIND_SKILLS_QUALIFIED,
    description:
      "List the user's installed Claude Code skills and slash commands that match a request (names may be misheard by speech), and plugins they could install from their marketplaces. Use when the user asks which skills exist, to find the right skill before handing work to Claude Code, or names a skill you don't recognise.",
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What the skill is for, or the (possibly misheard) skill name' } }, required: ['query'] },
  };

  constructor(private readonly catalog: SkillCatalog) {}

  policy(args: Record<string, unknown>): { mode: 'auto' | 'confirm' | 'block'; reason: string } {
    return typeof args.query === 'string' && args.query.trim() ? { mode: 'auto', reason: 'read-only lookup' } : { mode: 'block', reason: 'no query given' };
  }

  async call(args: Record<string, unknown>): Promise<{ ok: boolean; text: string; ms: number }> {
    const { installed, installable } = this.catalog.suggest(String(args.query ?? ''));
    const lines = [
      ...(installed.length ? ['Installed (invoke via Claude Code with the slash command):', ...installed.map((s) => `- ${s.command} — ${s.description.slice(0, 160)}`)] : ['No installed skill matches.']),
      ...(installable.length ? ['Not installed, available to install in Claude Code:', ...installable.map((p) => `- ${p.name} (${p.marketplace}) — ${p.description.slice(0, 120)} · install: ${p.install}`)] : []),
    ];
    return { ok: true, text: lines.join('\n'), ms: 0 };
  }
}

/** A short system hint for the tool-gather model when the user seems to be naming a skill or asking Claude. */
export function skillHint(catalog: SkillCatalog, utterance: string): string | undefined {
  if (!/\b(claude|skill|skills|slash|invoke|rca|plugin)\b|\//i.test(utterance)) return undefined;
  const matches = catalog.search(utterance, 3);
  if (matches.length === 0) return undefined;
  return [
    'Installed Claude Code skills that may be what the user means (speech recognition may have misheard the name):',
    ...matches.map((m) => `- ${m.command} — ${m.description.slice(0, 160)}`),
    'To run one, call coco__claude_code with `task` starting with that exact slash command followed by the user\'s issue. Do not use the terminal tool to start Claude or a skill.',
  ].join('\n');
}
