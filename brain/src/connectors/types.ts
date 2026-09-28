import { z } from 'zod';

export const Transport = z.enum(['stdio', 'http']);
export const ServerConfig = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),       // also the tool-name prefix
  name: z.string().min(1).max(60),
  transport: Transport,
  command: z.string().optional(), args: z.array(z.string()).default([]), cwd: z.string().optional(),
  url: z.string().url().optional(),
  envSecrets: z.array(z.string()).default([]),             // env var NAMES whose values live in Keychain
  headerSecrets: z.array(z.string()).default([]),          // header NAMES whose values live in Keychain
  auth: z.enum(['none', 'oauth']).default('none'),
  enabled: z.boolean().default(true),
  source: z.enum(['imported', 'catalog', 'custom']),
  readOnly: z.boolean().default(false),                    // informational ("--read-only" etc.)
  importKey: z.string().optional(),                        // stable dedupe key from discovery, used to track already-imported servers
}).refine((c) => (c.transport === 'stdio' ? !!c.command : !!c.url), { message: 'stdio needs command; http needs url' });
export type ServerConfig = z.infer<typeof ServerConfig>;
export type AutonomyMode = 'auto' | 'confirm' | 'off';
export type ServerState = 'disconnected' | 'connecting' | 'connected' | 'needs_auth' | 'error' | 'disabled';
export interface ServerStatus { id: string; state: ServerState; error?: string; toolCount: number; since: number }
export interface ToolInfo { serverId: string; name: string; qualified: string; description: string; inputSchema: Record<string, unknown> }
export const qualify = (serverId: string, tool: string): string => `${serverId}__${tool}`;
