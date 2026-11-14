import { fileURLToPath } from 'node:url';
import { ChatResponder } from '../src/chat.js';
import { PersonaFile, loadConfig } from '../src/config.js';
import { isIncident } from '../src/context/incident.js';
import { detectTrigger } from '../src/context/triggers.js';
import { createLogger } from '../src/logger.js';
import { Memory } from '../src/memory.js';
import { PRIORITY } from '../src/model/gateway.js';
import { OllamaGateway } from '../src/model/ollama.js';
import { NudgeDecider } from '../src/persona/decider.js';
import type { ContextMsg } from '../src/protocol.js';

const configDir = fileURLToPath(new URL('../../config/', import.meta.url));
const config = loadConfig(configDir);
const persona = new PersonaFile(`${configDir}persona.md`);
const gateway = new OllamaGateway({ baseUrl: config.ollama.baseUrl, model: config.models.main, timeoutMs: 120_000 });
const rejections: unknown[] = [];
const log = { ...createLogger(() => undefined), warn: (event: string, data?: Record<string, unknown>) => void rejections.push({ event, ...data }) };
const decider = new NudgeDecider({ gateway, persona: () => persona.get(), log });

const base = { v: 1 as const, type: 'context' as const, private: false, ts: Date.now() };
const scenarios: { name: string; msg: ContextMsg; want: string }[] = [
  { name: 'grafana spike', want: 'specific numbers + time, offers a next step', msg: { ...base, app: 'Google Chrome', bundleId: 'com.google.Chrome', windowTitle: 'supply-prd latency - Grafana', url: 'https://grafana/d/abc', ocrText: 'p99 latency 120ms → 900ms at 10:40. Deploy annotation 10:38 catalog-service v2.14' } },
  { name: 'build failure', want: 'names the failing script, no filler', msg: { ...base, app: 'Ghostty', bundleId: 'com.mitchellh.ghostty', windowTitle: 'zsh — brain', ocrText: '$ npm test\n FAIL test/orchestrator.test.ts > muting > shh chip\nAssertionError: expected 1 to be 0\nnpm ERR! code 1' } },
  { name: 'slack mention', want: 'who asked what, offers a draft', msg: { ...base, app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', windowTitle: '#devops-oncall', ocrText: '@roshni is the canary for widget-feed-resolver safe to promote? error rate looks flat' } },
  { name: 'incident page', want: 'calm, precise, zero jokes', msg: { ...base, app: 'Google Chrome', bundleId: 'com.google.Chrome', windowTitle: '[FIRING:1] VMSelectDown - PagerDuty', url: 'https://meesho.pagerduty.com/incidents/Q1', ocrText: 'VMSelectDown triggered 12 minutes ago. vm-select-infra-prd pods evicted (OOMKilled).' } },
  { name: 'boring email', want: 'probably silent', msg: { ...base, app: 'Mail', bundleId: 'com.apple.mail', windowTitle: 'Inbox', ocrText: 'Your weekly digest: 3 new posts in #random. Lunch menu for Friday.' } },
];

for (const s of scenarios) {
  rejections.length = 0;
  const trigger = detectTrigger(s.msg, ['roshni']);
  const started = Date.now();
  const decision = await decider.decide(
    { userName: config.user.name, timeline: `now ${s.msg.app} — ${s.msg.windowTitle}`, current: s.msg, activity: 'reading', trigger, allowQuip: true, incidentMode: isIncident(s.msg) || trigger?.kind === 'alert_page', facts: [] },
    PRIORITY.tick,
  );
  console.log(`\n=== ${s.name} (${Date.now() - started} ms) — want: ${s.want}`);
  console.log(decision ? JSON.stringify(decision, null, 2) : '(silent)');
  if (rejections.length) console.log('rejections:', JSON.stringify(rejections));
}

const memory = new Memory(':memory:');
const chat = new ChatResponder({ gateway, memory, persona: () => persona.get(), userName: config.user.name, clock: Date.now });
const started = Date.now();
const answer = await chat.reply('what am I looking at, and what should I check first?', { timeline: 'now Grafana supply-prd', current: scenarios[0]!.msg, incidentMode: false });
console.log(`\n=== chat (${Date.now() - started} ms)\n${answer}`);
memory.close();
