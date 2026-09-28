import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { AuditDecision, AuditLog } from '../agent/audit.js';
import { decide } from '../agent/autonomy.js';
import { discover, readSecretsFor, toServerConfig } from '../connectors/discovery.js';
import type { ConnectorManager } from '../connectors/manager.js';
import { DeniedHostError, uniqueId, type ConnectorRegistry } from '../connectors/registry.js';
import { secretKey, type SecretStore } from '../connectors/secrets.js';
import type { ServerConfig, ServerStatus } from '../connectors/types.js';

export interface ApiDeps {
  registry: ConnectorRegistry; manager: ConnectorManager; secrets: SecretStore; audit: AuditLog;
  health: () => Promise<boolean>; models: { main: string; vision: string };
  claudeJsonPath: string; scanDirs: () => string[]; addScanDir: (dir: string) => void; clock: () => number;
}
export interface ApiRequest { method: string; path: string; query: URLSearchParams; body: unknown }
export interface ApiResponse { status: number; json: unknown }

const ok = (json: unknown): ApiResponse => ({ status: 200, json });
const err = (status: number, error: string): ApiResponse => ({ status, json: { error } });
const defaultStatus = (id: string): ServerStatus => ({ id, state: 'disconnected', toolCount: 0, since: 0 }); // M8

const ImportBody = z.object({ key: z.string().min(1), confirm: z.literal(true) });
// I3: control characters (e.g. a pasted multi-line PEM/JSON credential) and oversize values are rejected here,
// up front, before anything is written to the registry or the secret store.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SecretValue = z.string().max(8192).refine((v) => !CONTROL_CHARS.test(v), { message: 'secret values must not contain control characters' });
const Secrets = z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), SecretValue);
// M7: userinfo in a custom URL (https://user:pass@host/mcp) would be persisted to disk in plaintext and echoed
// back from GET /api/connectors.
const NoUserinfoUrl = z.string().url().refine((u) => {
  try {
    const parsed = new URL(u);
    return parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}, { message: 'url must not contain userinfo' });
const CustomBody = z.object({
  name: z.string().min(1).max(60), transport: z.enum(['stdio', 'http']),
  command: z.string().min(1).optional(), args: z.array(z.string()).max(50).optional(), url: NoUserinfoUrl.optional(),
  env: Secrets.optional(), headers: Secrets.optional(), confirm: z.literal(true),
});
const ModeBody = z.object({ mode: z.enum(['auto', 'confirm', 'off']) });
const EnabledBody = z.object({ enabled: z.boolean() });
const TestBody = z.object({ args: z.record(z.string(), z.unknown()) });
const ScanDirBody = z.object({ dir: z.string().min(1) });

async function storeSecrets(deps: ApiDeps, id: string, values: Record<string, string>): Promise<void> {
  for (const [name, value] of Object.entries(values)) await deps.secrets.set(secretKey(id, name), value);
}

/** I3: undo a partial write. Deleting a name that was never actually stored is a harmless no-op in both stores. */
async function rollbackSecrets(deps: ApiDeps, id: string, names: Iterable<string>): Promise<void> {
  await Promise.allSettled([...names].map((name) => deps.secrets.delete(secretKey(id, name))));
}

function toolsFor(deps: ApiDeps, id: string) {
  return deps.manager.tools().filter((t) => t.serverId === id).map((t) => {
    const d = decide({ qualified: t.qualified, toolName: t.name, args: {}, override: deps.registry.autonomy(t.qualified), untrustedText: '' });
    return { qualified: t.qualified, name: t.name, description: t.description, mode: d.mode, reason: d.reason };
  });
}

/** M1: a malformed percent-escape (`%zz`) throws a URIError from decodeURIComponent; treat that as a 400, not a 500. */
function decodeSegments(path: string): string[] | undefined {
  const out: string[] = [];
  for (const s of path.split('/').filter(Boolean)) {
    try {
      out.push(decodeURIComponent(s));
    } catch {
      return undefined;
    }
  }
  return out;
}

export async function handleApi(req: ApiRequest, deps: ApiDeps): Promise<ApiResponse> {
  const { method, path } = req;
  const seg = decodeSegments(path); // ['api', ...]
  if (!seg) return err(400, 'malformed path');
  try {
    if (method === 'GET' && path === '/api/health') {
      const st = deps.manager.statuses();
      return ok({ brain: 'ok', ollama: await deps.health(), models: deps.models,
        connectors: { total: st.length, connected: st.filter((s) => s.state === 'connected').length, error: st.filter((s) => s.state === 'error' || s.state === 'needs_auth').length } });
    }
    if (method === 'GET' && path === '/api/connectors') {
      const statuses = new Map(deps.manager.statuses().map((s) => [s.id, s]));
      return ok(deps.registry.list().map((config) => ({ config, status: statuses.get(config.id) ?? defaultStatus(config.id), tools: toolsFor(deps, config.id) })));
    }
    if (method === 'GET' && path === '/api/discovery') {
      return ok({ servers: discover({ claudeJsonPath: deps.claudeJsonPath, scanDirs: deps.scanDirs(), importedKeys: deps.registry.importedKeys() }), scanDirs: deps.scanDirs() });
    }
    if (method === 'POST' && path === '/api/discovery/import') {
      const body = ImportBody.safeParse(req.body);
      if (!body.success) return err(400, 'key and confirm:true are required');
      const existing = deps.registry.list().find((s) => s.importKey === body.data.key);
      if (existing) return ok({ id: existing.id });
      const found = discover({ claudeJsonPath: deps.claudeJsonPath, scanDirs: deps.scanDirs(), importedKeys: new Set() }).find((d) => d.key === body.data.key);
      if (!found) return err(404, 'not found');
      if (found.status !== 'importable') return err(409, found.status);
      const cfg = toServerConfig(found, new Set(deps.registry.list().map((s) => s.id)));
      const values = readSecretsFor(found);
      const combined = { ...values.env, ...values.headers };
      // I3: store secrets after the importable check, before upsert; if upsert throws, delete what was just stored.
      await storeSecrets(deps, cfg.id, combined);
      try {
        deps.registry.upsert(cfg);
      } catch (e) {
        await rollbackSecrets(deps, cfg.id, Object.keys(combined));
        throw e;
      }
      void deps.manager.ensureConnected(cfg.id);
      return ok({ id: cfg.id });
    }
    if (method === 'POST' && path === '/api/connectors') {
      const body = CustomBody.safeParse(req.body);
      if (!body.success) return err(400, body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const b = body.data;
      const id = uniqueId(b.name, new Set(deps.registry.list().map((s) => s.id)));
      const cfg: ServerConfig = {
        id, name: b.name, transport: b.transport, ...(b.command ? { command: b.command } : {}), args: b.args ?? [], ...(b.url ? { url: b.url } : {}),
        envSecrets: Object.keys(b.env ?? {}), headerSecrets: Object.keys(b.headers ?? {}),
        auth: b.transport === 'http' && !b.headers ? 'oauth' : 'none', enabled: true, source: 'custom', readOnly: false,
      };
      deps.registry.upsert(cfg); // validates + denylist before any secret is stored
      const combined = { ...(b.env ?? {}), ...(b.headers ?? {}) };
      // I3: if a secret write fails after the config is persisted, roll both back rather than leave a half-configured connector.
      try {
        await storeSecrets(deps, id, combined);
      } catch (e) {
        await rollbackSecrets(deps, id, Object.keys(combined));
        deps.registry.remove(id);
        const message = e instanceof Error ? e.message : 'failed to store secrets';
        return err(e instanceof Error && /secret value/i.test(message) ? 400 : 500, message);
      }
      void deps.manager.ensureConnected(id);
      return ok({ id });
    }
    if (seg[1] === 'connectors' && seg[2]) {
      const cfg = deps.registry.get(seg[2]);
      if (!cfg) return err(404, 'not found');
      if (method === 'DELETE' && seg.length === 3) {
        await deps.manager.disconnect(cfg.id);
        for (const name of [...cfg.envSecrets, ...cfg.headerSecrets]) await deps.secrets.delete(secretKey(cfg.id, name));
        deps.registry.remove(cfg.id);
        return ok({ ok: true });
      }
      if (method === 'POST' && seg[3] === 'enabled') {
        const body = EnabledBody.safeParse(req.body);
        if (!body.success) return err(400, 'enabled must be a boolean');
        deps.registry.upsert({ ...cfg, enabled: body.data.enabled });
        if (!body.data.enabled) await deps.manager.disconnect(cfg.id);
        return ok({ ok: true });
      }
      if (method === 'POST' && seg[3] === 'reconnect') {
        await deps.manager.disconnect(cfg.id);
        return ok(await deps.manager.ensureConnected(cfg.id));
      }
    }
    if (seg[1] === 'tools' && seg[2]) {
      const qualified = seg[2];
      if (method === 'PUT' && seg[3] === 'mode') {
        const body = ModeBody.safeParse(req.body);
        if (!body.success) return err(400, 'mode must be auto, confirm or off');
        deps.registry.setAutonomy(qualified, body.data.mode);
        return ok({ ok: true });
      }
      if (method === 'POST' && seg[3] === 'test') {
        const body = TestBody.safeParse(req.body);
        if (!body.success) return err(400, 'args must be an object');
        const info = deps.manager.tools().find((t) => t.qualified === qualified);
        if (!info) return err(404, 'not found');
        const result = await deps.manager.callTool(qualified, body.data.args);
        deps.audit.record({ ts: deps.clock(), serverId: info.serverId, tool: info.name, decision: 'confirmed', ok: result.ok, ms: result.ms, resultChars: result.text.length, args: body.data.args });
        return ok(result);
      }
    }
    if (method === 'GET' && path === '/api/audit') {
      const limit = Number(req.query.get('limit') ?? '200');
      const decision = req.query.get('decision') as AuditDecision | null;
      return ok(deps.audit.list({ limit: Number.isFinite(limit) ? limit : 200, ...(req.query.get('serverId') ? { serverId: req.query.get('serverId')! } : {}), ...(decision ? { decision } : {}) }));
    }
    if (method === 'POST' && path === '/api/settings/scan-dirs') {
      const body = ScanDirBody.safeParse(req.body);
      const dir = body.success ? body.data.dir : '';
      if (!body.success || !isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) return err(400, 'dir must be an existing absolute directory');
      deps.addScanDir(dir);
      return ok({ scanDirs: deps.scanDirs() });
    }
    return err(404, 'not found');
  } catch (e) {
    if (e instanceof DeniedHostError) return err(409, e.message);
    if (e instanceof z.ZodError) return err(400, e.issues.map((i) => i.message).join('; '));
    if (e instanceof Error && /secret value/i.test(e.message)) return err(400, e.message);
    return err(500, 'internal error');
  }
}
