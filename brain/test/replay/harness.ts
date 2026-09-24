import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ChatResponder } from '../../src/chat.js';
import { DEFAULT_CONFIG, PersonaFile } from '../../src/config.js';
import { LookPolicy } from '../../src/context/look.js';
import { Timeline } from '../../src/context/timeline.js';
import { TriggerDeduper } from '../../src/context/triggers.js';
import { silentLogger } from '../../src/logger.js';
import { Memory } from '../../src/memory.js';
import { NudgePolicy } from '../../src/nudge/policy.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { NudgeDecider } from '../../src/persona/decider.js';
import { BodyToBrain, type BrainToBody, type SayMsg } from '../../src/protocol.js';
import type { ScriptedGateway } from '../helpers/fakes.js';
import { T0 } from '../helpers/messages.js';

export interface ReplayLine {
  at: number;
  msg: BodyToBrain;
}

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const PERSONA = new PersonaFile(fileURLToPath(new URL('../../../config/persona.md', import.meta.url)));

export function loadFixture(name: string): ReplayLine[] {
  return readFileSync(`${FIXTURES}${name}.jsonl`, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const raw = JSON.parse(l) as { at: number; msg: unknown };
      return { at: raw.at, msg: BodyToBrain.parse(raw.msg) };
    });
}

export async function runReplay(
  lines: ReplayLine[],
  opts: { gateway: ScriptedGateway; autoKeyframe?: boolean; tickEverySec?: number; endAfterSec?: number },
) {
  let now = T0;
  let ids = 0;
  const sent: { at: number; msg: BrainToBody }[] = [];
  const config = { ...DEFAULT_CONFIG, user: { name: 'Roshni', handles: ['roshni'] } };
  const memory = new Memory(':memory:');
  const clock = () => now;
  const orchestrator = new Orchestrator({
    send: (msg) => sent.push({ at: (now - T0) / 1000, msg }),
    clock,
    newId: () => `n${++ids}`,
    config,
    timeline: new Timeline(),
    look: new LookPolicy(config.look.dwellSec * 1000, config.look.maxPerMinute),
    policy: new NudgePolicy({ minGapMs: config.nudge.minGapSec * 1000 }),
    triggers: new TriggerDeduper(),
    decider: new NudgeDecider({ gateway: opts.gateway, visionGateway: opts.gateway, persona: () => PERSONA.get() }),
    chat: new ChatResponder({ gateway: opts.gateway, memory, persona: () => PERSONA.get(), userName: 'Roshni', clock }),
    memory,
    gateway: opts.gateway,
    keyframesEnabled: true,
    log: silentLogger,
  });

  const tickEvery = opts.tickEverySec ?? 25;
  const end = (lines.at(-1)?.at ?? 0) + (opts.endAfterSec ?? 30);
  let keyframeDueAt: number | undefined;
  for (let s = 0; s <= end; s++) {
    now = T0 + s * 1000;
    for (const line of lines.filter((l) => l.at === s)) {
      const msg = 'ts' in line.msg ? { ...line.msg, ts: now } : line.msg;
      await orchestrator.handle(msg);
    }
    if (keyframeDueAt === s) {
      keyframeDueAt = undefined;
      await orchestrator.handle({ v: 1, type: 'keyframe', jpegBase64: 'SlBFRw==', width: 1280, height: 800, ts: now });
    }
    if (s % 2 === 0) orchestrator.pulse();
    if (s > 0 && s % tickEvery === 0) await orchestrator.tick();
    const requested = sent.some((e) => e.at === s && e.msg.type === 'request_keyframe');
    if (opts.autoKeyframe && requested && keyframeDueAt === undefined) keyframeDueAt = s + 1;
  }
  memory.close();
  const says = sent.filter((e): e is { at: number; msg: SayMsg } => e.msg.type === 'say');
  return { sent, says };
}
