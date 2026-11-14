import { describe, expect, it } from 'vitest';
import { claimsDraftExists, extractDraft } from '../../src/persona/drafts.js';

describe('extractDraft', () => {
  it('recognises a fenced ```draft block (preferred), keeping the lead-in and trailing line', () => {
    const reply = "Here's a draft:\n```draft\nI'll check the pulse mcp setup tomorrow morning.\n```\nHead over to Slack and paste it.";
    expect(extractDraft(reply)).toEqual({
      text: "Here's a draft:\nHead over to Slack and paste it.",
      draft: "I'll check the pulse mcp setup tomorrow morning.",
    });
  });

  it('recognises a "Draft:" line as the fallback format, taking the rest of the message as the draft', () => {
    const reply = 'Sure thing.\nDraft: I will check the pulse mcp setup tomorrow morning.';
    expect(extractDraft(reply)).toEqual({
      text: 'Sure thing.',
      draft: 'I will check the pulse mcp setup tomorrow morning.',
    });
  });

  it('prefers the fenced block over a "Draft:" line when both are present', () => {
    const reply = 'Draft: not this one\n```draft\nThe real draft.\n```';
    expect(extractDraft(reply)).toEqual({ text: 'Draft: not this one', draft: 'The real draft.' });
  });

  it('returns the trimmed reply with a null draft when there is no draft block', () => {
    expect(extractDraft('Just a regular reply, no draft here.')).toEqual({
      text: 'Just a regular reply, no draft here.',
      draft: null,
    });
  });

  it('returns a null draft for an empty fenced block, keeping the surrounding text', () => {
    const reply = "Nothing to send yet.\n```draft\n```\nTell me what you'd like to say.";
    expect(extractDraft(reply)).toEqual({
      text: "Nothing to send yet.\nTell me what you'd like to say.",
      draft: null,
    });
  });

  it('returns a null draft for an empty "Draft:" line', () => {
    expect(extractDraft('No draft yet.\nDraft: ')).toEqual({ text: 'No draft yet.', draft: null });
  });

  it('preserves internal newlines in a multi-line fenced draft', () => {
    const reply = '```draft\nHi Prince,\n\nI will join at 3pm.\n\nThanks\n```\nPaste when ready.';
    expect(extractDraft(reply)).toEqual({
      text: 'Paste when ready.',
      draft: 'Hi Prince,\n\nI will join at 3pm.\n\nThanks',
    });
  });

  it('preserves internal newlines in a multi-line "Draft:" message', () => {
    const reply = 'Draft: Hi Prince,\nI will join at 3pm.\nThanks';
    expect(extractDraft(reply)).toEqual({ text: '', draft: 'Hi Prince,\nI will join at 3pm.\nThanks' });
  });

  it('caps the draft at 4000 characters', () => {
    const long = 'a'.repeat(5000);
    const reply = `\`\`\`draft\n${long}\n\`\`\``;
    const result = extractDraft(reply);
    expect(result.draft).toHaveLength(4000);
    expect(result.draft).toBe(long.slice(0, 4000));
  });

  describe('an unclosed fence (the model got cut off before the closing ```)', () => {
    it('treats everything after ```draft as the draft, and never leaves the raw marker in text', () => {
      const reply = "Here's what I've got:\n```draft\nHi Prince, let's sync at 3pm.";
      const result = extractDraft(reply);
      expect(result).toEqual({ text: "Here's what I've got:", draft: "Hi Prince, let's sync at 3pm." });
      expect(result.text).not.toContain('```');
    });

    it('strips the bare marker (draft null) when there is nothing after it', () => {
      const result = extractDraft('Nothing yet.\n```draft');
      expect(result).toEqual({ text: 'Nothing yet.', draft: null });
      expect(result.text).not.toContain('```');
    });

    it('strips the bare marker when only whitespace follows it', () => {
      const result = extractDraft('Nothing yet.\n```draft\n   \n');
      expect(result).toEqual({ text: 'Nothing yet.', draft: null });
      expect(result.text).not.toContain('```');
    });
  });

  describe('multiple fenced draft blocks', () => {
    it('uses the first block as the draft and removes every ```draft…``` block from the text', () => {
      const reply =
        'First take:\n```draft\nHi there.\n```\nActually, try this instead:\n```draft\nHello!\n```\nPick whichever.';
      const result = extractDraft(reply);
      expect(result).toEqual({
        text: 'First take:\nActually, try this instead:\nPick whichever.',
        draft: 'Hi there.',
      });
      expect(result.text).not.toContain('```');
    });

    it('handles three blocks, still preferring the first', () => {
      const reply = '```draft\nOne\n```\n```draft\nTwo\n```\n```draft\nThree\n```\nDone.';
      const result = extractDraft(reply);
      expect(result).toEqual({ text: 'Done.', draft: 'One' });
      expect(result.text).not.toContain('```');
    });
  });
});

describe('claimsDraftExists', () => {
  it.each([
    "I've drafted a reply mentioning the postmortem.",
    'I have drafted a message for you.',
    "Here's a draft for you.",
    'Here is a draft ready to go.',
    'The draft is ready.',
    'Draft below.',
  ])('flags: %s', (text) => {
    expect(claimsDraftExists(text)).toBe(true);
  });

  it.each(['What should the draft say?', 'Want me to draft something?', 'The draft was rejected by review.', 'Just a regular reply.'])(
    'does not flag: %s',
    (text) => {
      expect(claimsDraftExists(text)).toBe(false);
    },
  );
});
