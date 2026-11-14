import { describe, expect, it } from 'vitest';
import { FILLER_PATTERNS, countSentences } from '../../src/persona/selfcheck.js';
import type { SayMsg } from '../../src/protocol.js';
import { ScriptedGateway, json } from '../helpers/fakes.js';
import { loadFixture, runReplay } from './harness.js';

const GOOD = { speak: true, kind: 'suggestion', text: 'p99 on supply-prd went 120ms to 900ms at 10:40. Line it up with the last deploy?', chips: ['check deploys'], pointAt: '10:40' };
const eager = () => new ScriptedGateway(() => json(GOOD));

function expectOnBrand(says: { msg: SayMsg }[]) {
  for (const { msg } of says.filter((s) => s.msg.kind !== 'status' && s.msg.kind !== 'reply')) {
    for (const p of FILLER_PATTERNS) expect(msg.text).not.toMatch(p);
    expect(countSentences(msg.text)).toBeLessThanOrEqual(2);
    expect((msg.text.match(/!/g) ?? []).length).toBeLessThanOrEqual(1);
  }
}

const unsolicited = (says: { at: number; msg: SayMsg }[]) => says.filter((s) => s.msg.kind !== 'status' && s.msg.kind !== 'reply');

describe('replay: focus is sacred', () => {
  it('never speaks, looks or even asks the model while the user types for 10 minutes', async () => {
    const gw = eager();
    const { sent } = await runReplay(loadFixture('typing-focus'), { gateway: gw, autoKeyframe: true });
    expect(gw.calls).toHaveLength(0);
    expect(sent.filter((e) => e.msg.type === 'say' || e.msg.type === 'request_keyframe')).toHaveLength(0);
  });
});

describe('replay: dwelling on a dashboard', () => {
  it('looks once after ~5s, comments with the screenshot, and speaks at most twice in 5 minutes', async () => {
    const gw = eager();
    const { sent, says } = await runReplay(loadFixture('grafana-dwell'), { gateway: gw, autoKeyframe: true });
    const firstLook = sent.find((e) => e.msg.type === 'request_keyframe')!;
    expect(firstLook.at).toBeGreaterThanOrEqual(5);
    expect(firstLook.at).toBeLessThanOrEqual(8);
    const nudges = unsolicited(says);
    expect(nudges[0]!.at).toBeLessThanOrEqual(10);
    expect(gw.calls[0]!.messages.at(-1)!.images).toEqual(['SlBFRw==']);
    expect(nudges.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < nudges.length; i++) expect(nudges[i]!.at - nudges[i - 1]!.at).toBeGreaterThanOrEqual(180);
    expectOnBrand(says);
  });
});

describe('replay: an over-eager model', () => {
  it('is throttled: gaps of at least 180s that grow as nudges are ignored', async () => {
    const { says } = await runReplay(loadFixture('runbook-reading'), { gateway: eager() });
    const nudges = unsolicited(says);
    expect(nudges.length).toBeGreaterThanOrEqual(3);
    expect(nudges.length).toBeLessThanOrEqual(5);
    const gaps = nudges.slice(1).map((n, i) => n.at - nudges[i]!.at);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(180);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]!);
    expectOnBrand(says);
  });
});

describe('replay: a rambling model', () => {
  it('rejects the observed wrong-shape melodrama and speaks the corrected reply', async () => {
    const zephyr = json({ decision: 'speak', reasoning: 'massive spike', action: 'alert_matey', message: 'Zephyr, wake up! The charts are screaming!' });
    const gw = new ScriptedGateway((_, i) => (i === 0 ? zephyr : json(GOOD)));
    const { says } = await runReplay(loadFixture('runbook-reading'), { gateway: gw, endAfterSec: 0 });
    expect(unsolicited(says)[0]!.msg.text).toBe(GOOD.text);
    expect(gw.calls[1]!.messages.at(-1)!.content).toMatch(/wrong shape/);
    expect(says.every((s) => !s.msg.text.includes('Zephyr'))).toBe(true);
  });
});

describe('replay: incidents', () => {
  it('stays silent rather than joking when the model only offers quips', async () => {
    const gw = new ScriptedGateway(() => json({ ...GOOD, kind: 'quip', text: 'Well, this is spicy.' }));
    const { says } = await runReplay(loadFixture('incident-page'), { gateway: gw });
    expect(unsolicited(says)).toHaveLength(0);
    expect(gw.calls[0]!.messages[0]!.content).toContain('INCIDENT MODE');
  });

  it('speaks immediately (trigger) with a calm, emoji-free suggestion', async () => {
    const calm = { ...GOOD, text: 'VMSelectDown has been firing 12 minutes. Pods on vm-select-infra-prd were evicted.' };
    const { says } = await runReplay(loadFixture('incident-page'), { gateway: new ScriptedGateway(() => json(calm)) });
    const first = unsolicited(says)[0]!;
    expect(first.at).toBe(1);
    expect(first.msg.kind).toBe('suggestion');
    expect(first.msg.text).not.toMatch(/\p{Extended_Pictographic}/u);
    expectOnBrand(says);
  });
});

describe('replay: triggers wait for the user to be free', () => {
  it('holds a build failure while typing and raises it as soon as the user stops', async () => {
    const gw = eager();
    const { says } = await runReplay(loadFixture('build-failure-while-typing'), { gateway: gw });
    const nudges = unsolicited(says);
    expect(nudges.every((n) => n.at >= 10)).toBe(true);
    // the second (near-identical) context ping at t=11 re-detects the trigger before any pulse retry gets to it.
    expect(nudges[0]!.at).toBe(10);
    expect(gw.calls[0]!.messages[1]!.content).toContain('Trigger: build_failed');
  });

  it('holds a build failure while typing and retries it via pulse once the user stops, with no further context updates', async () => {
    const gw = eager();
    const { says } = await runReplay(loadFixture('build-failure-static'), { gateway: gw });
    const nudges = unsolicited(says);
    expect(nudges.every((n) => n.at >= 10)).toBe(true);
    expect(nudges).toHaveLength(1);
    expect(gw.calls[0]!.messages[1]!.content).toContain('Trigger: build_failed');
  });
});
