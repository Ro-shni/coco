import { describe, expect, it } from 'vitest';
import { extractAction, intentAllowsAction } from '../../src/persona/actions.js';

describe('extractAction', () => {
  it('returns the text unchanged with a null action and blockPresent=false when there is no action block', () => {
    expect(extractAction('Just a normal reply.')).toEqual({ text: 'Just a normal reply.', action: null, blockPresent: false });
  });

  it('extracts a url action, stripping the fenced block from the text', () => {
    const raw = 'On it.\n```action\n{"open":"url","url":"https://www.youtube.com/results?search_query=x","label":"x on YouTube"}\n```\nOpening that up.';
    expect(extractAction(raw)).toEqual({
      text: 'On it.\nOpening that up.',
      action: { open: 'url', url: 'https://www.youtube.com/results?search_query=x', label: 'x on YouTube' },
      blockPresent: true,
    });
  });

  it('extracts an app action', () => {
    const raw = '```action\n{"open":"app","target":"Arc"}\n```\nBringing up Arc.';
    expect(extractAction(raw)).toEqual({ text: 'Bringing up Arc.', action: { open: 'app', target: 'Arc' }, blockPresent: true });
  });

  it('rejects a url action whose scheme is not http/https, but still reports blockPresent=true', () => {
    const raw = '```action\n{"open":"url","url":"javascript:alert(1)","label":"x"}\n```\nDone.';
    expect(extractAction(raw)).toEqual({ text: 'Done.', action: null, blockPresent: true });
  });

  it('rejects malformed JSON inside the block, still stripping it and reporting blockPresent=true', () => {
    const raw = '```action\nnot json\n```\nDone.';
    expect(extractAction(raw)).toEqual({ text: 'Done.', action: null, blockPresent: true });
  });

  it('rejects a block missing required fields, still reporting blockPresent=true', () => {
    const raw = '```action\n{"open":"app"}\n```\nDone.';
    expect(extractAction(raw)).toEqual({ text: 'Done.', action: null, blockPresent: true });
  });

  it('never returns more than one action even if the model emits two blocks', () => {
    const raw =
      '```action\n{"open":"app","target":"Arc"}\n```\n```action\n{"open":"app","target":"Slack"}\n```\nDone.';
    const result = extractAction(raw);
    expect(result.action).toEqual({ open: 'app', target: 'Arc' });
    expect(result.text).toBe('Done.');
  });

  it('rejects an app action whose target is longer than 120 chars (still stripping the block)', () => {
    const raw = `\`\`\`action\n{"open":"app","target":"${'a'.repeat(121)}"}\n\`\`\`\nDone.`;
    expect(extractAction(raw)).toEqual({ text: 'Done.', action: null, blockPresent: true });
  });

  it('rejects a url action whose label is longer than 80 chars', () => {
    const raw = `\`\`\`action\n{"open":"url","url":"https://example.com","label":"${'a'.repeat(81)}"}\n\`\`\`\nDone.`;
    expect(extractAction(raw)).toEqual({ text: 'Done.', action: null, blockPresent: true });
  });

  it('rejects a url action whose url is longer than 2048 chars', () => {
    const raw = `\`\`\`action\n{"open":"url","url":"https://example.com/${'a'.repeat(2048)}","label":"x"}\n\`\`\`\nDone.`;
    expect(extractAction(raw)).toEqual({ text: 'Done.', action: null, blockPresent: true });
  });

  it('accepts a target/label/url right at the cap', () => {
    const raw = `\`\`\`action\n{"open":"app","target":"${'a'.repeat(120)}"}\n\`\`\`\nDone.`;
    expect(extractAction(raw).action).toEqual({ open: 'app', target: 'a'.repeat(120) });
  });
});

describe('intentAllowsAction', () => {
  it.each([
    // Imperative at clause start.
    ['open youtube', true],
    ['play some lofi on youtube', true],
    ['search for dynamic programming videos', true],
    ['show me the grafana dashboard', true],
    ['go to slack', true],
    ['bring up my terminal', true],
    ['pull up the runbook', true],
    ['take me to the incident channel', true],
    // Allowed lead-ins before the verb.
    ['can you launch Arc', true],
    ['could you open youtube', true],
    ['would you please start Spotify', true],
    ['please start Spotify', true],
    ['I want you to open Slack', true],
    ['Coco, open youtube', true],
    ['hey coco, can you open youtube', true],
    // Wh-questions never pass, even when they mention an action verb.
    ["what's this?", false],
    ['what is dynamic programming', false],
    ['what does this show?', false],
    ['where do I start?', false],
    ['why did this open?', false],
    // An action verb NOT at clause start / after an allowed lead-in does not count — this is the
    // injection-resistance fix (M7): a verb merely mentioned mid-sentence must not satisfy the gate.
    ['I like to search for recipes sometimes', false],
    ['my friend said open the pod bay doors', false],
    ['tell me why the play button is disabled', false],
    ['hello', false],
    ['', false],
  ] as const)('%s -> %s', (utterance, expected) => {
    expect(intentAllowsAction(utterance)).toBe(expected);
  });
});
