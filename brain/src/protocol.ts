import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;
const v = z.literal(PROTOCOL_VERSION);
const ts = z.number().int();

export const ActivityState = z.enum(['typing', 'reading', 'idle', 'in_call', 'sharing']);
export type ActivityState = z.infer<typeof ActivityState>;

export const Mood = z.enum(['bored', 'curious', 'focused', 'worried', 'sleepy']);
export type Mood = z.infer<typeof Mood>;

export const SayKind = z.enum(['quip', 'suggestion', 'question', 'status', 'reply']);
export type SayKind = z.infer<typeof SayKind>;

export const ContextMsg = z.object({
  v,
  type: z.literal('context'),
  app: z.string(),
  bundleId: z.string(),
  windowTitle: z.string(),
  url: z.string().optional(),
  selection: z.string().optional(),
  ocrText: z.string().optional(),
  private: z.boolean(),
  ts,
});
export type ContextMsg = z.infer<typeof ContextMsg>;

export const ActivityMsg = z.object({ v, type: z.literal('activity'), state: ActivityState, ts });
export type ActivityMsg = z.infer<typeof ActivityMsg>;

export const KeyframeMsg = z.object({
  v,
  type: z.literal('keyframe'),
  jpegBase64: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  ts,
});
export type KeyframeMsg = z.infer<typeof KeyframeMsg>;

export const UtteranceMsg = z.object({
  v,
  type: z.literal('utterance'),
  text: z.string().min(1).max(4000),
  source: z.enum(['voice', 'chat']),
});
export type UtteranceMsg = z.infer<typeof UtteranceMsg>;

export const ChipMsg = z.object({ v, type: z.literal('chip'), nudgeId: z.string(), choice: z.string() });
export type ChipMsg = z.infer<typeof ChipMsg>;

export const FocusResultMsg = z.object({
  v,
  type: z.literal('focus_result'),
  requestId: z.string(),
  ok: z.boolean(),
  matched: z.string().optional(),
});
export type FocusResultMsg = z.infer<typeof FocusResultMsg>;

export const PasteResultMsg = z.object({
  v,
  type: z.literal('paste_result'),
  requestId: z.string(),
  ok: z.boolean(),
  detail: z.string().optional(),
});
export type PasteResultMsg = z.infer<typeof PasteResultMsg>;

export const BodyToBrain = z.discriminatedUnion('type', [ContextMsg, ActivityMsg, KeyframeMsg, UtteranceMsg, ChipMsg, FocusResultMsg, PasteResultMsg]);
export type BodyToBrain = z.infer<typeof BodyToBrain>;

export const SayMsg = z.object({
  v,
  type: z.literal('say'),
  nudgeId: z.string(),
  text: z.string(),
  kind: SayKind,
  chips: z.array(z.string()).max(4),
  speak: z.boolean(),
  pointAt: z.string().optional(),
  draft: z.string().min(1).max(4000).optional(),
  draftApp: z.string().min(1).max(120).optional(),
});
export type SayMsg = z.infer<typeof SayMsg>;

export const RequestKeyframeMsg = z.object({ v, type: z.literal('request_keyframe'), reason: z.string() });
export type RequestKeyframeMsg = z.infer<typeof RequestKeyframeMsg>;

export const MoodMsg = z.object({ v, type: z.literal('mood'), mood: Mood });
export type MoodMsg = z.infer<typeof MoodMsg>;

export const FocusMsg = z.object({
  v,
  type: z.literal('focus'),
  requestId: z.string().min(1),
  target: z.string().min(1).max(120),
  kind: z.enum(['app', 'window']),
});
export type FocusMsg = z.infer<typeof FocusMsg>;

export const PasteMsg = z.object({
  v,
  type: z.literal('paste'),
  requestId: z.string().min(1),
  text: z.string().min(1).max(4000),
  app: z.string().min(1).max(120),
});
export type PasteMsg = z.infer<typeof PasteMsg>;

export const BrainToBody = z.discriminatedUnion('type', [SayMsg, RequestKeyframeMsg, MoodMsg, FocusMsg, PasteMsg]);
export type BrainToBody = z.infer<typeof BrainToBody>;

export function parseBodyMessage(raw: string): BodyToBrain | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = BodyToBrain.safeParse(json);
  return result.success ? result.data : null;
}

export function encodeBrainMessage(msg: BrainToBody): string {
  return JSON.stringify(BrainToBody.parse(msg));
}
