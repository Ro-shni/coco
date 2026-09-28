import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const ConfigSchema = z
  .object({
    models: z.object({ main: z.string().min(1), vision: z.string().min(1).nullable() }),
    ollama: z.object({ baseUrl: z.url() }),
    nudge: z.object({
      minGapSec: z.number().int().min(30),
      tickMinSec: z.number().int().min(5),
      tickMaxSec: z.number().int().min(5),
      ignoreAfterSec: z.number().int().min(5),
    }),
    look: z.object({ dwellSec: z.number().min(1), maxPerMinute: z.number().int().min(0).max(10) }),
    user: z.object({ name: z.string(), handles: z.array(z.string()) }),
    voice: z.object({ enabled: z.boolean(), speakNudges: z.boolean(), speakTypedReplies: z.boolean() }),
    debug: z.object({ logContext: z.boolean(), trace: z.boolean() }),
    connectors: z.object({ scanDirs: z.array(z.string()) }),
  })
  .refine((c) => c.nudge.tickMaxSec >= c.nudge.tickMinSec, {
    message: 'nudge.tickMaxSec must be >= nudge.tickMinSec',
    path: ['nudge', 'tickMaxSec'],
  });

export type CocoConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: CocoConfig = Object.freeze({
  models: { main: 'qwen3.5:9b', vision: null },
  ollama: { baseUrl: 'http://127.0.0.1:11434' },
  nudge: { minGapSec: 180, tickMinSec: 20, tickMaxSec: 30, ignoreAfterSec: 20 },
  look: { dwellSec: 5, maxPerMinute: 3 },
  user: { name: '', handles: [] },
  voice: { enabled: true, speakNudges: true, speakTypedReplies: false },
  debug: { logContext: false, trace: false },
  connectors: { scanDirs: [] },
}) as CocoConfig;

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const keys = new Set([...Object.keys(base), ...Object.keys(override)]);
  return Object.fromEntries([...keys].map((k) => [k, deepMerge(base[k], override[k])]));
}

export function loadConfig(dir: string): CocoConfig {
  const path = join(dir, 'config.yaml');
  const user: unknown = existsSync(path) ? (parse(readFileSync(path, 'utf8')) ?? {}) : {};
  const result = ConfigSchema.safeParse(deepMerge(DEFAULT_CONFIG, user));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid config.yaml (${path}): ${issues}`);
  }
  return result.data;
}

export const FALLBACK_PERSONA = [
  '# Coco',
  'You are Coco, a smart, observant and dryly funny desktop companion.',
  'Be specific, be brief, never use filler, and drop the jokes when something is on fire.',
].join('\n');

export class PersonaFile {
  private cached: { mtimeMs: number; text: string } | undefined;

  constructor(private readonly path: string) {}

  get(): string {
    if (!existsSync(this.path)) return FALLBACK_PERSONA;
    const mtimeMs = statSync(this.path).mtimeMs;
    if (this.cached?.mtimeMs !== mtimeMs) {
      this.cached = { mtimeMs, text: readFileSync(this.path, 'utf8') };
    }
    return this.cached.text;
  }
}
