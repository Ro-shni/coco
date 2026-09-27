import { describe, expect, it } from 'vitest';
import { extractAction, intentAllowsAction } from '../../src/persona/actions.js';

describe('extractAction', () => {
  it('returns the text unchanged with a null action when there is no action block', () => {
    expect(extractAction('Just a normal reply.')).toEqual({ text: 'Just a normal reply.', action: null });
  });

  it('extracts a url action, stripping the fenced block from the text', () => {
    const raw = 'On it.\n```action\n{"open":"url","url":"https://www.youtube.com/results?search_query=x","label":"x on YouTube"}\n```\nOpening that up.';
    expect(extractAction(raw)).toEqual({
      text: 'On it.\nOpening that up.',
      action: { open: 'url', url: 'https://www.youtube.com/results?search_query=x', label: 'x on YouTube' },
    });
  });

  it('extracts an app action', () => {
    const raw = '```action\n{"open":"app","target":"Arc"}\n```\nBringing up Arc.';
    expect(extractAction(raw)).toEqual({ text: 'Bringing up Arc.', action: { open: 'app', target: 'Arc' } });
  });

  it('rejects a url action whose scheme is not http/https', () => {
    const raw = '```action\n{"open":"url","url":"javascript:alert(1)","label":"x"}\n```\nDone.';
    expect(extractAction(raw)).toEqual({ text: 'Done.', action: null });
  });

  it('rejects malformed JSON inside the block, still stripping it', () => {
    const raw = '```action\nnot json\n```\nDone.';
    expect(extractAction(raw)).toEqual({ text: 'Done.', action: null });
  });

  it('rejects a block missing required fields', () => {
    const raw = '```action\n{"open":"app"}\n```\nDone.';
    expect(extractAction(raw)).toEqual({ text: 'Done.', action: null });
  });

  it('never returns more than one action even if the model emits two blocks', () => {
    const raw =
      '```action\n{"open":"app","target":"Arc"}\n```\n```action\n{"open":"app","target":"Slack"}\n```\nDone.';
    const result = extractAction(raw);
    expect(result.action).toEqual({ open: 'app', target: 'Arc' });
    expect(result.text).toBe('Done.');
  });
});

describe('intentAllowsAction', () => {
  it.each([
    ['open youtube', true],
    ['can you launch Arc', true],
    ['please start Spotify', true],
    ['play some lofi on youtube', true],
    ['search for dynamic programming videos', true],
    ['show me the grafana dashboard', true],
    ['go to slack', true],
    ['bring up my terminal', true],
    ['pull up the runbook', true],
    ['take me to the incident channel', true],
    ["what's this?", false],
    ['what is dynamic programming', false],
    ['hello', false],
    ['', false],
  ] as const)('%s -> %s', (utterance, expected) => {
    expect(intentAllowsAction(utterance)).toBe(expected);
  });
});
