import { silentLogger, type Logger } from '../logger.js';
import type { ChatMessage, ModelGateway, Priority } from '../model/gateway.js';
import { noopTrace, type DecisionTrace, type TraceModelCall } from '../trace.js';
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
      /** Opt-in decision trace (see trace.ts, config debug.trace). Defaults to a no-op. */
      trace?: DecisionTrace;
      clock?: () => number;
    },
  ) {}

  async decide(input: DecideInput, priority: Priority): Promise<NudgeDecision | null> {
    const log = this.deps.log ?? silentLogger;
    const trace = this.deps.trace ?? noopTrace;
    const clock = this.deps.clock ?? Date.now;
    const useVision = input.keyframe !== undefined && this.deps.visionGateway !== undefined;
    const gateway = useVision ? this.deps.visionGateway! : this.deps.gateway;
    const base = buildNudgeMessages({ ...input, persona: this.deps.persona(), hasImage: useVision });
    let conversation = useVision ? attachImage(base, input.keyframe!) : base;
    const modelCalls: TraceModelCall[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const startedAt = clock();
      const raw = await gateway.chat({ messages: conversation, format: NUDGE_JSON_SCHEMA, priority, temperature: 0.7 });
      modelCalls.push({ n: attempt, purpose: 'nudge', ms: clock() - startedAt, rawReply: raw });
      const parsed = parseDecision(raw);
      if (parsed.ok && !parsed.decision.speak) {
        trace.logNudgeDecision({ modelCalls, decision: null, selfcheckProblems: [] });
        return null;
      }
      const problems = parsed.ok ? this.problemsFor(parsed.decision, input) : [parsed.error];
      if (parsed.ok && problems.length === 0) {
        trace.logNudgeDecision({ modelCalls, decision: parsed.decision, selfcheckProblems: [] });
        return parsed.decision;
      }
      log.warn('nudge_rejected', { attempt, problems });
      if (attempt === MAX_ATTEMPTS) trace.logNudgeDecision({ modelCalls, decision: null, selfcheckProblems: problems });
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
