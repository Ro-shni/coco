import { silentLogger, type Logger } from '../logger.js';
import type { ChatMessage, ModelGateway, Priority } from '../model/gateway.js';
import { NUDGE_JSON_SCHEMA, parseDecision, type NudgeDecision } from './decision.js';
import { buildNudgeMessages, buildRetryMessage, type NudgePromptInput } from './prompt.js';
import { checkReply } from './selfcheck.js';

export type DecideInput = Omit<NudgePromptInput, 'persona' | 'hasImage'> & { keyframe?: string };

const MAX_ATTEMPTS = 2;
const UNSOLICITED_MAX_SENTENCES = 2;

function attachImage(messages: ChatMessage[], image: string): ChatMessage[] {
  const last = messages.at(-1)!;
  return [...messages.slice(0, -1), { ...last, images: [image] }];
}

export class NudgeDecider {
  constructor(
    private readonly deps: {
      gateway: ModelGateway;
      visionGateway?: ModelGateway;
      persona: () => string;
      log?: Logger;
    },
  ) {}

  async decide(input: DecideInput, priority: Priority): Promise<NudgeDecision | null> {
    const log = this.deps.log ?? silentLogger;
    const useVision = input.keyframe !== undefined && this.deps.visionGateway !== undefined;
    const gateway = useVision ? this.deps.visionGateway! : this.deps.gateway;
    const base = buildNudgeMessages({ ...input, persona: this.deps.persona(), hasImage: useVision });
    let conversation = useVision ? attachImage(base, input.keyframe!) : base;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const raw = await gateway.chat({ messages: conversation, format: NUDGE_JSON_SCHEMA, priority, temperature: 0.7 });
      const parsed = parseDecision(raw);
      if (parsed.ok && !parsed.decision.speak) return null;
      const problems = parsed.ok ? this.problemsFor(parsed.decision, input) : [parsed.error];
      if (parsed.ok && problems.length === 0) return parsed.decision;
      log.warn('nudge_rejected', { attempt, problems });
      conversation = [...conversation, { role: 'assistant', content: raw }, buildRetryMessage(problems)];
    }
    return null;
  }

  private problemsFor(decision: NudgeDecision, input: DecideInput): string[] {
    const { problems } = checkReply({
      text: decision.text,
      kind: decision.kind,
      incidentMode: input.incidentMode,
      maxSentences: UNSOLICITED_MAX_SENTENCES,
    });
    return decision.kind === 'quip' && !input.allowQuip && !input.incidentMode
      ? [...problems, 'kind "quip" is not allowed this turn']
      : problems;
  }
}
