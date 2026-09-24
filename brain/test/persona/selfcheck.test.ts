import { describe, expect, it } from 'vitest';
import { checkReply, claimsUnperformedAction, countSentences } from '../../src/persona/selfcheck.js';

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

describe('claimsUnperformedAction', () => {
  it.each([
    ["Sent to Prince. He's waiting for the `pulse mcp` approval.", 'Sent'],
    ['I sent the reply', 'I sent'],
    ['Done — approved.', 'Done'],
    ["I've posted it in #incidents.", "I've posted"],
    ['Okay, I just merged the PR.', 'I just merged'],
    ['I created a PR for that.', 'I created a PR'],
  ])('flags a completed outward action: %s', (text, phrase) => {
    expect(claimsUnperformedAction(text)).toBe(phrase);
  });

  it.each([
    "I can't send messages yet, here's a draft:",
    'I cannot post there, but here is a draft.',
    "I didn't send anything.",
    'Prince sent you a message',
    'You sent the PR yesterday',
    'the alert was sent by pagerduty',
    'He posted the runbook at 10:40.',
    'Done with the review?',
    'p99 jumped at 10:40. Want me to bring Grafana to the front?',
  ])('does not flag: %s', (text) => {
    expect(claimsUnperformedAction(text)).toBeNull();
  });

  it('is reported by checkReply as a problem', () => {
    const r = checkReply({ ...base, text: 'Sent to Prince.' });
    expect(r.ok).toBe(false);
    expect(r.problems).toContain(
      'claims an action you did not perform: "Sent" — you cannot send, post, click, type, approve or merge; say so and offer a draft instead',
    );
  });

  it.each([
    'Message sent!',
    'Just sent it over',
    "It's sent.",
    "That's sent.",
    'All sent.',
    'Message sent to Prince.',
    'Your message has been sent.',
    'Approved ✅',
    "I've replied to Prince",
    'Done, posted it',
    'Done.',
    'Forwarded it to Prince.',
    "We've pinged the on-call.",
    'Everything has been shared.',
    "It's sent, anything else?",
  ])('flags a completion claim in any phrasing: %s', (text) => {
    expect(claimsUnperformedAction(text)).not.toBeNull();
  });

  it.each([
    'Prince sent you a message',
    'you replied yesterday',
    "I can't send yet",
    'Nothing was sent',
    "It hasn't been sent",
    'Want me to draft it so you can send it?',
    'the alert was sent by pagerduty',
    "Here's a draft:\n```draft\nSent from my phone\n```",
    'Approved?',
    'Done yet?',
    "Prince's message was sent at 10:12.",
  ])('does not flag a negated, third-party, question or drafted phrasing: %s', (text) => {
    expect(claimsUnperformedAction(text)).toBeNull();
  });

  it.each(['Message sent!', "It's sent.", "That's sent.", 'All sent.', 'Just sent it over', 'Message sent to Prince.', 'Your message has been sent.'])(
    'checkReply rejects the previously missed phrasing: %s',
    (text) => {
      const r = checkReply({ ...base, kind: 'reply', maxSentences: 6, text });
      expect(r.ok).toBe(false);
      expect(r.problems.join()).toMatch(/^claims an action you did not perform: "/);
    },
  );
});

