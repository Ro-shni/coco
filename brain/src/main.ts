import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditLog } from './agent/audit.js';
import { ToolLoop } from './agent/loop.js';
import { ChatResponder } from './chat.js';
import { PersonaFile, loadConfig } from './config.js';
import { ConnectorManager } from './connectors/manager.js';
import { OAuthFlows } from './connectors/oauth.js';
import { startOAuthCallbackServer, type OAuthCallbackServer } from './connectors/oauthCallbackServer.js';
import { ConnectorRegistry } from './connectors/registry.js';
import { KeychainSecretStore, MemorySecretStore, type SecretStore } from './connectors/secrets.js';
import { LookPolicy } from './context/look.js';
import { Timeline } from './context/timeline.js';
import { TriggerDeduper } from './context/triggers.js';
import { createLogger } from './logger.js';
import { createDecisionTrace } from './trace.js';
import { Memory } from './memory.js';
import type { ModelGateway } from './model/gateway.js';
import { OllamaGateway } from './model/ollama.js';
import { NudgePolicy } from './nudge/policy.js';
import { Orchestrator } from './orchestrator.js';
import { NudgeDecider } from './persona/decider.js';
import type { BodyToBrain } from './protocol.js';
import { startServer, type BrainServer } from './server.js';
import { appendScanDir } from './studio/configWriter.js';
import { createStudioHandler } from './studio/http.js';
import { MemorySessionStore } from './studio/sessions.js';

const PULSE_MS = 2000;
const HEALTH_MS = 15_000;
/** How often a server left `error`/`needs_auth` after its own back-off gets another connect attempt.
 * `ensureConnected` is a no-op for servers already connected or still inside their back-off window. */
const CONNECT_RETRY_MS = 30_000;

const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);

async function main(): Promise<void> {
  const log = createLogger();
  const token = process.env.COCO_TOKEN;
  if (!token || token.length < 32) {
    log.error('startup_failed', { reason: 'COCO_TOKEN (>= 32 chars) is required' });
    process.exit(2);
  }
  const configDir = resolve(process.env.COCO_CONFIG_DIR ?? join(process.cwd(), '..', 'config'));
  const dataDir = resolve(process.env.COCO_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'Coco'));
  mkdirSync(dataDir, { recursive: true });

  const config = loadConfig(configDir);
  const persona = new PersonaFile(join(configDir, 'persona.md'));
  const gateway = new OllamaGateway({ baseUrl: config.ollama.baseUrl, model: config.models.main });
  let visionGateway: ModelGateway | undefined;
  if (await gateway.supportsVision()) visionGateway = gateway;
  else if (config.models.vision) visionGateway = new OllamaGateway({ baseUrl: config.ollama.baseUrl, model: config.models.vision });
  log.info('models', { main: config.models.main, vision: visionGateway === gateway ? config.models.main : (config.models.vision ?? 'none') });

  const memory = new Memory(join(dataDir, 'coco.db'));
  const logsDir = resolve(process.env.COCO_LOGS_DIR ?? join(homedir(), 'Library', 'Logs', 'Coco'));
  const trace = createDecisionTrace(config.debug.trace, { logsDir, clock: Date.now, newId: randomUUID });
  if (config.debug.trace) log.info('trace_enabled', { file: 'trace.jsonl' });

  const registry = new ConnectorRegistry(configDir);
  const secrets: SecretStore = process.platform === 'darwin' ? new KeychainSecretStore() : new MemorySecretStore();
  if (process.platform !== 'darwin') log.warn('secrets_in_memory');
  const manager = new ConnectorManager({ registry, secrets, clock: Date.now, log });
  // The OAuth redirect is served by its own fixed-port listener (started after COCO_READY, below) rather than
  // the brain's own ephemeral port: a redirect URI has to stay the same across restarts, and pre-registered
  // apps (Slack) list it exactly.
  const oauth = new OAuthFlows({
    secrets,
    redirectUrl: () => `http://127.0.0.1:${config.connectors.oauthCallbackPort}/oauth/callback`,
    clock: Date.now,
    log,
  });
  manager.oauthProviderFor = (cfg) => oauth.providerFor(cfg);
  const audit = new AuditLog(join(dataDir, 'coco.db'), { storeArgs: config.debug.trace });
  const tools = new ToolLoop({ gateway, manager, registry, audit, clock: Date.now, log });
  let scanDirs = [...config.connectors.scanDirs];

  let server: BrainServer | undefined;
  const orchestrator = new Orchestrator({
    send: (m) => server?.send(m),
    clock: Date.now,
    newId: randomUUID,
    config,
    timeline: new Timeline(),
    look: new LookPolicy(config.look.dwellSec * 1000, config.look.maxPerMinute),
    policy: new NudgePolicy({ minGapMs: config.nudge.minGapSec * 1000 }),
    triggers: new TriggerDeduper(),
    decider: new NudgeDecider({ gateway, visionGateway, persona: () => persona.get(), log, trace }),
    chat: new ChatResponder({ gateway, memory, persona: () => persona.get(), userName: config.user.name, clock: Date.now, logger: log, trace }),
    memory,
    gateway,
    keyframesEnabled: visionGateway !== undefined,
    log,
    trace,
    tools,
  });

  let recordPath = process.env.COCO_RECORD;
  const startedAt = Date.now();
  const record = (msg: BodyToBrain) => {
    if (recordPath) {
      try {
        appendFileSync(recordPath, `${JSON.stringify({ at: Math.round((Date.now() - startedAt) / 1000), msg })}\n`);
      } catch (err: unknown) {
        log.warn('record_failed', { error: String(err) });
        recordPath = undefined;
      }
    }
  };

  const studioToken = process.env.COCO_STUDIO_TOKEN;
  const studioEnabled = typeof studioToken === 'string' && studioToken.length >= 32;
  if (!studioEnabled) log.warn('studio_disabled');
  const onHttp = studioEnabled
    ? createStudioHandler({
        token: studioToken!,
        staticDir: fileURLToPath(new URL('./studio/', import.meta.url)),
        log,
        sessions: new MemorySessionStore(),
        api: {
          registry, manager, secrets, audit, oauth,
          health: () => gateway.health(),
          models: { main: config.models.main, vision: config.models.vision ?? config.models.main },
          claudeJsonPath: join(homedir(), '.claude.json'),
          scanDirs: () => scanDirs,
          addScanDir: (dir) => {
            appendScanDir(join(configDir, 'config.yaml'), dir);
            scanDirs = [...new Set([...scanDirs, dir])];
          },
          clock: Date.now,
        },
      })
    : undefined;

  server = await startServer({
    token,
    log,
    onConnect: () => orchestrator.onBodyConnected(),
    onMessage: (msg) => {
      record(msg);
      orchestrator.handle(msg).catch((err: unknown) => log.error('handle_failed', { error: String(err) }));
    },
    ...(onHttp ? { onHttp } : {}),
  });
  process.stdout.write(`COCO_READY ${JSON.stringify({ port: server.port })}\n`);
  log.info('ready', { port: server.port, configDir, dataDir });

  // The callback server is started only now (never awaited before COCO_READY): a slow or failing bind here
  // must not delay the Body's connection to the WebSocket. A bind failure (e.g. the port is already in use by
  // another Coco instance) is logged and the brain keeps running with connector sign-in unavailable.
  let oauthCallbackServer: OAuthCallbackServer | undefined;
  try {
    oauthCallbackServer = await startOAuthCallbackServer({
      port: config.connectors.oauthCallbackPort,
      log,
      handle: async (query) => {
        const r = await oauth.handleCallback(query);
        if (r.serverId) {
          await manager.disconnect(r.serverId);
          void manager.ensureConnected(r.serverId);
        }
        return r;
      },
    });
  } catch (err: unknown) {
    log.warn('oauth_callback_unavailable', { error: err instanceof Error ? err.message : String(err) });
  }

  void manager.connectAll();
  const connectRetryTimer = setInterval(() => void manager.connectAll(), CONNECT_RETRY_MS);

  setInterval(() => {
    orchestrator.pulse().catch((err: unknown) => log.error('pulse_failed', { error: String(err) }));
  }, PULSE_MS);
  setInterval(() => void orchestrator.checkHealth(), HEALTH_MS);
  void orchestrator.checkHealth();
  const scheduleTick = (): void => {
    const delay = randomBetween(config.nudge.tickMinSec, config.nudge.tickMaxSec) * 1000;
    setTimeout(() => {
      orchestrator
        .tick()
        .catch((err: unknown) => log.error('tick_failed', { error: String(err) }))
        .finally(scheduleTick);
    }, delay);
  };
  scheduleTick();

  let stopping = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info('shutdown', { reason });
    clearInterval(connectRetryTimer);
    await server?.close();
    await oauthCallbackServer?.close();
    await manager.closeAll();
    audit.close();
    memory.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.stdin.on('end', () => void shutdown('parent closed stdin'));
  process.stdin.resume();
}

main().catch((err: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', event: 'fatal', error: String(err) })}\n`);
  process.exit(1);
});
