import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { uniqueId } from './registry.js';
import type { ServerConfig } from './types.js';

export const CatalogEntry = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), name: z.string(), description: z.string(),
  transport: z.enum(['stdio', 'http']), url: z.string().url().optional(), command: z.string().optional(), args: z.array(z.string()).optional(),
  auth: z.enum(['oauth', 'headers', 'env', 'none']), headerNames: z.array(z.string()).optional(), envNames: z.array(z.string()).optional(),
  needsClientId: z.boolean().optional(), argsHint: z.string().optional(), setupNotes: z.string(), docsUrl: z.string().url(),
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;

export function loadCatalog(): CatalogEntry[] {
  const raw = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8')) as unknown;
  return z.array(CatalogEntry).parse(raw);
}

export function catalogToConfig(
  e: CatalogEntry,
  taken: ReadonlySet<string>,
  input: { clientId?: string; env?: Record<string, string>; headers?: Record<string, string>; args?: string[] },
): ServerConfig {
  if (e.needsClientId && !input.clientId) throw new Error(`${e.name} needs a Client ID`);
  return {
    id: uniqueId(e.id, taken), name: e.name, transport: e.transport,
    ...(e.url ? { url: e.url } : {}), ...(e.command ? { command: e.command } : {}),
    args: [...(e.args ?? []), ...(input.args ?? [])],
    envSecrets: e.envNames ?? [], headerSecrets: e.headerNames ?? [],
    auth: e.auth === 'oauth' ? 'oauth' : 'none', enabled: true, source: 'catalog', readOnly: false,
    ...(input.clientId ? { oauthClientId: input.clientId } : {}),
  };
}
