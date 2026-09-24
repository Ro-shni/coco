import { describe, expect, it } from 'vitest';
import { checkReply, countSentences } from '../../src/persona/selfcheck.js';

const base = { kind: 'suggestion' as const, incidentMode: false, maxSentences: 2 };

describe('countSentences', () => {
  it('counts sentences split by terminal punctuation', () => {
    expect(countSentences('One. Two! Three?')).toBe(3);
    expect(countSentences('p99 went 120ms → 900ms at 10:40. Check deploys?')).toBe(2);
    expect(countSentences('   ')).toBe(0);
  });
});

describe('checkReply', () => {
  it('passes a crisp, specific line', () => {
    expect(checkReply({ ...base, text: 'p99 on supply-prd went 120ms to 900ms at 10:40. Want me to line it up with the last deploy?' })).toEqual({ ok: true, problems: [] });
  });

  it.each(['Great question, the pod is down.', 'The pod is down. Let me know if you need anything.', 'Sure! The pod is down.', 'It looks like there is an error.', 'Feel free to ask.'])(
    'flags filler: %s',
    (text) => {
      const r = checkReply({ ...base, text });
      expect(r.ok).toBe(false);
      expect(r.problems.join()).toMatch(/filler/);
    },
  );

  it('flags replies over the sentence limit', () => {
    const r = checkReply({ ...base, text: 'One. Two. Three.' });
    expect(r.problems).toContain('too long: 3 sentences (max 2)');
  });

  it('flags melodrama (more than one exclamation mark), as in the observed reply', () => {
    const r = checkReply({ ...base, maxSentences: 10, text: "Zephyr, wake up! The charts are screaming! That's like a sloth on espresso!" });
    expect(r.problems.join()).toMatch(/exclamation/);
  });

  it('forbids quips and emoji in incident mode', () => {
    const quip = checkReply({ ...base, kind: 'quip', incidentMode: true, text: 'Spicy.' });
    expect(quip.problems).toContain('no jokes during an incident');
    const emoji = checkReply({ ...base, incidentMode: true, text: 'vmselect is down 🌶️' });
    expect(emoji.problems).toContain('no emoji during an incident');
  });

  it('flags empty replies', () => {
    expect(checkReply({ ...base, text: '  ' }).problems).toContain('empty reply');
  });
});
