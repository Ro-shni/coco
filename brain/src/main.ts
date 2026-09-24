import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ChatResponder } from './chat.js';
import { PersonaFile, loadConfig } from './config.js';
import { LookPolicy } from './context/look.js';
import { Timeline } from './context/timeline.js';
import { TriggerDeduper } from './context/triggers.js';
import { createLogger } from './logger.js';
import { Memory } from './memory.js';
import type { ModelGateway } from './model/gateway.js';
import { OllamaGateway } from './model/ollama.js';
import { NudgePolicy } from './nudge/policy.js';
import { Orchestrator } from './orchestrator.js';
import { NudgeDecider } from './persona/decider.js';
import type { BodyToBrain } from './protocol.js';
import { startServer, type BrainServer } from './server.js';

const PULSE_MS = 2000;
const HEALTH_MS = 15_000;

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
    decider: new NudgeDecider({ gateway, visionGateway, persona: () => persona.get(), log }),
    chat: new ChatResponder({ gateway, memory, persona: () => persona.get(), userName: config.user.name, clock: Date.now, logger: log }),
    memory,
    gateway,
    keyframesEnabled: visionGateway !== undefined,
    log,
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

  server = await startServer({
    token,
    log,
    onConnect: () => orchestrator.onBodyConnected(),
    onMessage: (msg) => {
      record(msg);
      orchestrator.handle(msg).catch((err: unknown) => log.error('handle_failed', { error: String(err) }));
    },
  });
  process.stdout.write(`COCO_READY ${JSON.stringify({ port: server.port })}\n`);
  log.info('ready', { port: server.port, configDir, dataDir });

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
    await server?.close();
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
