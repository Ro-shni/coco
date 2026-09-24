import { z } from 'zod';

export const NudgeDecision = z.object({
  speak: z.boolean(),
  kind: z.enum(['quip', 'suggestion', 'question']),
  text: z.string().max(400),
  chips: z.array(z.string().min(1).max(24)).max(3),
  pointAt: z.string().max(120).nullable(),
});
export type NudgeDecision = z.infer<typeof NudgeDecision>;

export const NUDGE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    speak: { type: 'boolean' },
    kind: { type: 'string', enum: ['quip', 'suggestion', 'question'] },
    text: { type: 'string' },
    chips: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    pointAt: { type: ['string', 'null'] },
  },
  required: ['speak', 'kind', 'text', 'chips', 'pointAt'],
  additionalProperties: false,
};

const tryParse = (s: string): unknown | undefined => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

export function extractJson(raw: string): unknown | undefined {
  const unfenced = raw.replace(/```(?:json)?/gi, '').trim();
  const direct = tryParse(unfenced);
  if (direct !== undefined) return direct;
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  return start >= 0 && end > start ? tryParse(unfenced.slice(start, end + 1)) : undefined;
}

export type ParseResult = { ok: true; decision: NudgeDecision } | { ok: false; error: string };

export function parseDecision(raw: string): ParseResult {
  const json = extractJson(raw);
  if (json === undefined) return { ok: false, error: 'reply was not JSON' };
  const result = NudgeDecision.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ');
    return { ok: false, error: `wrong shape: ${issues}` };
  }
  return { ok: true, decision: result.data };
}
