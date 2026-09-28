import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { isDeniedHost } from './hosts.js';
import { ServerConfig, type AutonomyMode } from './types.js';

export class DeniedHostError extends Error {
  override name = 'DeniedHostError';
}

const MODES: ReadonlySet<string> = new Set(['auto', 'confirm', 'off']);

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'server';
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) if (!taken.has(`${slug}-${n}`)) return `${slug}-${n}`;
}

export class ConnectorRegistry {
  private servers: ServerConfig[] = [];
  private modes: Record<string, AutonomyMode> = {};

  constructor(private readonly configDir: string) {
    this.reload();
  }

  private get serversPath(): string { return join(this.configDir, 'connectors.yaml'); }
  private get autonomyPath(): string { return join(this.configDir, 'autonomy.yaml'); }

  reload(): void {
    const raw = existsSync(this.serversPath) ? (parse(readFileSync(this.serversPath, 'utf8')) as { servers?: unknown[] } | null) : null;
    this.servers = (raw?.servers ?? []).flatMap((s) => {
      const r = ServerConfig.safeParse(s);
      return r.success ? [r.data] : [];
    });
    const modes = existsSync(this.autonomyPath) ? (parse(readFileSync(this.autonomyPath, 'utf8')) as { tools?: Record<string, unknown> } | null) : null;
    this.modes = Object.fromEntries(
      Object.entries(modes?.tools ?? {}).filter((e): e is [string, AutonomyMode] => typeof e[1] === 'string' && MODES.has(e[1])),
    );
  }

  list(): ServerConfig[] { return [...this.servers]; }
  get(id: string): ServerConfig | undefined { return this.servers.find((s) => s.id === id); }

  upsert(cfg: ServerConfig): void {
    const parsed = ServerConfig.parse(cfg);
    if (parsed.url && isDeniedHost(parsed.url)) throw new DeniedHostError(`Refusing production host: ${new URL(parsed.url).hostname}`);
    this.servers = [...this.servers.filter((s) => s.id !== parsed.id), parsed];
    this.saveServers();
  }

  remove(id: string): void {
    this.servers = this.servers.filter((s) => s.id !== id);
    this.modes = Object.fromEntries(Object.entries(this.modes).filter(([k]) => !k.startsWith(`${id}__`)));
    this.saveServers();
    this.saveModes();
  }

  autonomy(qualifiedTool: string): AutonomyMode | undefined { return this.modes[qualifiedTool]; }

  setAutonomy(qualifiedTool: string, mode: AutonomyMode): void {
    this.modes = { ...this.modes, [qualifiedTool]: mode };
    this.saveModes();
  }

  private saveServers(): void { writeAtomic(this.serversPath, stringify({ servers: this.servers })); }
  private saveModes(): void { writeAtomic(this.autonomyPath, stringify({ tools: this.modes })); }
}
