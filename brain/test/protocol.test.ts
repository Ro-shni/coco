import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BodyToBrain, BrainToBody, encodeBrainMessage, parseBodyMessage } from '../src/protocol.js';

const FIXTURES = fileURLToPath(new URL('../../protocol/fixtures', import.meta.url));
const load = (dir: string) =>
  readdirSync(join(FIXTURES, dir)).map((f) => ({ name: f, raw: readFileSync(join(FIXTURES, dir, f), 'utf8') }));

describe('protocol contract fixtures', () => {
  it.each(load('body'))('Body→Brain fixture $name parses and round-trips unchanged', ({ raw }) => {
    const parsed = BodyToBrain.parse(JSON.parse(raw));
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(JSON.parse(raw));
  });

  it.each(load('brain'))('Brain→Body fixture $name parses and round-trips unchanged', ({ raw }) => {
    const parsed = BrainToBody.parse(JSON.parse(raw));
    expect(JSON.parse(encodeBrainMessage(parsed))).toEqual(JSON.parse(raw));
  });
});

describe('parseBodyMessage', () => {
  it('returns null for invalid JSON', () => {
    expect(parseBodyMessage('{nope')).toBeNull();
  });

  it('returns null for an unknown type', () => {
    expect(parseBodyMessage('{"v":1,"type":"teleport"}')).toBeNull();
  });

  it('returns null for a wrong protocol version', () => {
    expect(parseBodyMessage('{"v":2,"type":"chip","nudgeId":"a","choice":"b"}')).toBeNull();
  });

  it('rejects an utterance longer than 4000 chars', () => {
    const text = 'a'.repeat(4001);
    expect(parseBodyMessage(JSON.stringify({ v: 1, type: 'utterance', text, source: 'chat' }))).toBeNull();
  });

  it('parses a valid activity message', () => {
    expect(parseBodyMessage('{"v":1,"type":"activity","state":"typing","ts":1}')).toEqual({
      v: 1, type: 'activity', state: 'typing', ts: 1,
    });
  });
});

describe('encodeBrainMessage', () => {
  it('throws on a message that violates the schema', () => {
    // @ts-expect-error deliberately invalid mood
    expect(() => encodeBrainMessage({ v: 1, type: 'mood', mood: 'ecstatic' })).toThrow();
  });
});
