import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDeniedHost } from './hosts.js';
import { uniqueId } from './registry.js';
import type { ServerConfig } from './types.js';

export type DiscoveryStatus = 'importable' | 'blocked_host' | 'unsupported_variable' | 'unsupported_transport' | 'already_imported';

export interface DiscoveredServer {
  key: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args: string[];
  url?: string;
  envNames: string[];
  headerNames: string[];
  foundIn: string[];
  status: DiscoveryStatus;
  readOnly: boolean;
}

interface RawEntry { type?: unknown; command?: unknown; args?: unknown; url?: unknown; env?: unknown; headers?: unknown }

const VAR = /\$\{[^}]+\}/;
const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((a): a is string => typeof a === 'string') : []);
const keysOf = (x: unknown): string[] => (x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x).sort() : []);

function readServers(path: string): Record<string, RawEntry> {
  try {
    const json = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: unknown };
    const s = json.mcpServers;
    return s && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, RawEntry>) : {};
  } catch {
    return {};
  }
}

function mcpFilesIn(dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const candidates = [dir, ...readdirSync(dir).map((c) => join(dir, c))];
    for (const c of candidates) {
      const f = join(c, '.mcp.json');
      try {
        if (statSync(c).isDirectory() && existsSync(f)) out.push(f);
      } catch {
        /* unreadable entry: skip */
      }
    }
  }
  return out;
}

function toDiscovered(name: string, e: RawEntry, file: string): Omit<DiscoveredServer, 'status' | 'foundIn'> & { rawTransport: string } {
  const rawTransport = typeof e.type === 'string' ? e.type : typeof e.url === 'string' && !e.command ? 'http' : 'stdio';
  const transport = rawTransport === 'http' ? 'http' : 'stdio';
  const command = typeof e.command === 'string' ? e.command : undefined;
  const args = strings(e.args);
  const url = typeof e.url === 'string' ? e.url : undefined;
  const identity = transport === 'http' ? `http ${url ?? ''}` : `stdio ${command ?? ''} ${args.join(' ')}`;
  const key = createHash('sha256').update(`${rawTransport}|${identity}`).digest('hex').slice(0, 16);
  void file;
  return {
    key, name, transport, command, args, url, rawTransport,
    envNames: keysOf(e.env),
    headerNames: keysOf(e.headers),
    readOnly: args.includes('--read-only') || /-?read-?only$/i.test(name),
  };
}

function statusOf(d: ReturnType<typeof toDiscovered>, imported: ReadonlySet<string>): DiscoveryStatus {
  if (imported.has(d.key)) return 'already_imported';
  if (d.rawTransport !== 'http' && d.rawTransport !== 'stdio') return 'unsupported_transport';
  if ([d.command ?? '', d.url ?? '', ...d.args].some((s) => VAR.test(s))) return 'unsupported_variable';
  if (d.url && isDeniedHost(d.url)) return 'blocked_host';
  return 'importable';
}

export function discover(opts: { claudeJsonPath: string; scanDirs: string[]; importedKeys: ReadonlySet<string> }): DiscoveredServer[] {
  const files = [opts.claudeJsonPath, ...mcpFilesIn(opts.scanDirs)].filter((f) => existsSync(f));
  const byKey = new Map<string, DiscoveredServer>();
  for (const file of files) {
    for (const [name, entry] of Object.entries(readServers(file))) {
      const d = toDiscovered(name, entry, file);
      const existing = byKey.get(d.key);
      if (existing) {
        existing.foundIn = [...existing.foundIn, file];
        continue;
      }
      const { rawTransport: _rt, ...rest } = d;
      byKey.set(d.key, { ...rest, foundIn: [file], status: statusOf(d, opts.importedKeys) });
    }
  }
  return [...byKey.values()];
}

export function readSecretsFor(server: DiscoveredServer): { env: Record<string, string>; headers: Record<string, string> } {
  for (const file of server.foundIn) {
    for (const [name, entry] of Object.entries(readServers(file))) {
      if (toDiscovered(name, entry, file).key !== server.key) continue;
      const pick = (x: unknown) =>
        Object.fromEntries(Object.entries((x ?? {}) as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
      return { env: pick(entry.env), headers: pick(entry.headers) };
    }
  }
  return { env: {}, headers: {} };
}

export function toServerConfig(d: DiscoveredServer, taken: ReadonlySet<string>): ServerConfig {
  return {
    id: uniqueId(d.name, taken),
    name: d.name,
    transport: d.transport,
    ...(d.command !== undefined ? { command: d.command } : {}),
    args: d.args,
    ...(d.url !== undefined ? { url: d.url } : {}),
    envSecrets: d.envNames,
    headerSecrets: d.headerNames,
    auth: d.transport === 'http' && d.headerNames.length === 0 ? 'oauth' : 'none',
    enabled: true,
    source: 'imported',
    importKey: d.key,
    readOnly: d.readOnly,
  };
}
