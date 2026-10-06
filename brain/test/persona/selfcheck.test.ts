import { describe, expect, it } from 'vitest';
import { checkReply, claimsPendingAction, claimsUnperformedAction, countSentences } from '../../src/persona/selfcheck.js';

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
    ['I opened Arc for you.', 'I opened'],
    ['I launched Chrome.', 'I launched'],
    ['Opened.', 'Opened'],
    ['Launched, one sec.', 'Launched'],
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
    'The file opened automatically.',
    'The PR was opened by CI.',
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

  const factualNudges = [
    'Deployed at 10:38, p99 jumped from 120ms to 900ms.',
    'Merged 20 minutes ago, the canary is at 10%.',
    'Posted in #devops-oncall: vmselect is down.',
    'Approved by Prince, waiting on CI.',
    'Scheduled for 21:12 tonight.',
  ];

  it.each(factualNudges)('does not flag a factual nudge that opens with a participle: %s', (text) => {
    expect(claimsUnperformedAction(text)).toBeNull();
  });

  it.each(factualNudges)('lets a factual nudge through checkReply: %s', (text) => {
    expect(checkReply({ ...base, text })).toEqual({ ok: true, problems: [] });
  });

  it.each([
    'Message sent!',
    'Just sent it over',
    "It's sent.",
    "That's sent.",
    'All sent.',
    'Message sent to Prince.',
    'Your message has been sent.',
    "Sent to Prince. He's waiting for the approval.",
    'Done — approved.',
    'Approved ✅',
    'Posted it.',
    'Sent that over to Prince.',
  ])('still flags a bare completion with an object, recipient or clause end: %s', (text) => {
    expect(claimsUnperformedAction(text)).not.toBeNull();
  });

  it.each(['Deployed to prd at 10:38.', 'Merged to main 20 minutes ago.', 'Scheduled to run at 21:12.'])(
    'does not treat "to <env>" after a deploy/merge-family verb as a recipient: %s',
    (text) => {
      expect(claimsUnperformedAction(text)).toBeNull();
      expect(checkReply({ ...base, text }).ok).toBe(true);
    },
  );

  it.each(['Sent to Prince.', 'Posted to #devops-oncall.', 'Forwarded to Prince.', 'Deployed it.', 'Merged.'])(
    'still flags send-family "to <recipient>" and deploy/merge with an object or clause end: %s',
    (text) => {
      expect(claimsUnperformedAction(text)).not.toBeNull();
    },
  );
});

describe('claimsPendingAction', () => {
  it.each([
    'Opening the docs for you now.',
    'Opening YouTube for you now.',
    'Pulling that up.',
    'Pulling it up.',
    'Bringing that up.',
    'Launching Arc for you now.',
    'Searching for that up now.',
    // I2 remainder (round 2): named by the reviewer as missed false negatives.
    'Opening it.',
    'Opening it!',
    'Launching Arc.',
    'Launching Slack.',
    'Let me open that.',
    'Let me pull that up.',
    'Here it is.',
    'Here you go.',
  ])('flags a progressive in-flight claim or stock hand-off line: %s', (text) => {
    expect(claimsPendingAction(text)).toBe(true);
  });

  it.each([
    "I can't open that right now.",
    "I'm not opening that.",
    'The docs are open in another tab.',
    'Slack is already open.',
    "That's a Grafana dashboard for supply-prd.",
    'p99 jumped at 10:40.',
    '',
  ])('does not flag ordinary or negated text: %s', (text) => {
    expect(claimsPendingAction(text)).toBe(false);
  });

  it('is not also flagged by claimsUnperformedAction (progressive, not a completion claim)', () => {
    expect(claimsUnperformedAction('Opening YouTube for you now.')).toBeNull();
    expect(claimsUnperformedAction('Here you go.')).toBeNull();
    expect(claimsUnperformedAction('Launching Arc.')).toBeNull();
  });
});


describe('claimsUnperformedAction — "running" claims', () => {
  it.each([
    'Runnig in background: `npx tsc` and `npx jest`. Want me to bring Terminal to the front?',
    'Running `npm test` now.',
    "I'm running the build in the background.",
    'Kicked off `git pull` for you.',
    'Executing the migration right now.',
  ])('flags: %s', (t) => {
    expect(claimsUnperformedAction(t)).not.toBeNull();
  });

  it.each([
    'Want me to run the tests?',
    'You have 38 Claude processes running.',
    'The server is running on port 3000.',
    'Is the build running?',
  ])('does not flag: %s', (t) => {
    expect(claimsUnperformedAction(t)).toBeNull();
  });
});
