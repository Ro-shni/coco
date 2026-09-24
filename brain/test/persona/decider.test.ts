import { describe, expect, it } from 'vitest';
import { ModelUnavailableError, PRIORITY } from '../../src/model/gateway.js';
import { NudgeDecider, type DecideInput } from '../../src/persona/decider.js';
import { ScriptedGateway, json } from '../helpers/fakes.js';
import { ctx } from '../helpers/messages.js';

const input: DecideInput = {
  userName: 'Roshni',
  timeline: '10:02 Grafana',
  current: ctx(),
  activity: 'reading',
  trigger: null,
  allowQuip: true,
  incidentMode: false,
  facts: [],
};
const good = { speak: true, kind: 'suggestion', text: 'p99 jumped at 10:40. Check the 10:38 deploy?', chips: ['check deploys'], pointAt: '10:40' };
const persona = () => '# persona';

describe('NudgeDecider', () => {
  it('returns a valid decision on the first try', async () => {
    const gw = new ScriptedGateway(() => json(good));
    const d = await new NudgeDecider({ gateway: gw, persona }).decide(input, PRIORITY.tick);
    expect(d).toEqual(good);
    expect(gw.calls).toHaveLength(1);
    expect(gw.calls[0]!.format).toBeDefined();
    expect(gw.calls[0]!.priority).toBe(PRIORITY.tick);
  });

  it('returns null when the model chooses silence', async () => {
    const gw = new ScriptedGateway(() => json({ ...good, speak: false }));
    expect(await new NudgeDecider({ gateway: gw, persona }).decide(input, PRIORITY.tick)).toBeNull();
  });

  it('retries once with the problems when the shape is wrong, then succeeds', async () => {
    const gw = new ScriptedGateway((_, i) => (i === 0 ? json({ decision: 'speak', message: 'Zephyr!' }) : json(good)));
    const d = await new NudgeDecider({ gateway: gw, persona }).decide(input, PRIORITY.tick);
    expect(d).toEqual(good);
    expect(gw.calls).toHaveLength(2);
    const retry = gw.calls[1]!.messages.at(-1)!;
    expect(retry.content).toMatch(/wrong shape/);
    expect(gw.calls[1]!.messages.at(-2)!.role).toBe('assistant');
  });

  it('gives up (null) after two failed attempts', async () => {
    const gw = new ScriptedGateway(() => json({ ...good, text: 'One. Two. Three. Four.' }));
    expect(await new NudgeDecider({ gateway: gw, persona }).decide(input, PRIORITY.tick)).toBeNull();
    expect(gw.calls).toHaveLength(2);
  });

  it('rejects quips when not allowed', async () => {
    const gw = new ScriptedGateway(() => json({ ...good, kind: 'quip' }));
    expect(await new NudgeDecider({ gateway: gw, persona }).decide({ ...input, allowQuip: false }, PRIORITY.tick)).toBeNull();
    expect(gw.calls[1]!.messages.at(-1)!.content).toContain('kind "quip" is not allowed this turn');
  });

  it('uses the vision gateway and attaches the keyframe when one is given', async () => {
    const text = new ScriptedGateway(() => json(good));
    const vision = new ScriptedGateway(() => json(good));
    await new NudgeDecider({ gateway: text, visionGateway: vision, persona }).decide({ ...input, keyframe: 'JPEG' }, PRIORITY.tick);
    expect(text.calls).toHaveLength(0);
    expect(vision.calls[0]!.messages.at(-1)!.images).toEqual(['JPEG']);
  });

  it('ignores the keyframe when no vision gateway is configured', async () => {
    const text = new ScriptedGateway(() => json(good));
    await new NudgeDecider({ gateway: text, persona }).decide({ ...input, keyframe: 'JPEG' }, PRIORITY.tick);
    expect(text.calls[0]!.messages.some((m) => m.images)).toBe(false);
  });

  it('propagates ModelUnavailableError', async () => {
    const gw = new ScriptedGateway(() => new ModelUnavailableError('down'));
    await expect(new NudgeDecider({ gateway: gw, persona }).decide(input, PRIORITY.tick)).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it('rejects a nudge that claims an action Coco did not perform (retry, then null)', async () => {
    const gw = new ScriptedGateway(() => json({ ...good, text: 'Done — approved Prince\'s request.' }));
    expect(await new NudgeDecider({ gateway: gw, persona }).decide(input, PRIORITY.tick)).toBeNull();
    expect(gw.calls).toHaveLength(2);
    expect(gw.calls[1]!.messages.at(-1)!.content).toContain('claims an action you did not perform');
  });
});
