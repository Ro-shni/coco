import { describe, expect, it } from 'vitest';
import { isIncident } from '../../src/context/incident.js';
import { ctx } from '../helpers/messages.js';

describe('isIncident', () => {
  it.each([
    ['title', { windowTitle: '[FIRING:3] VMSelectDown' }],
    ['url', { url: 'https://meesho.pagerduty.com/incidents/Q1' }],
    ['ocr', { ocrText: 'SEV-1 declared, join the war room' }],
    ['selection', { selection: 'outage in supply' }],
  ])('detects incidents from %s', (_, o) => {
    expect(isIncident(ctx({ windowTitle: 'x', url: undefined, ocrText: undefined, ...o }))).toBe(true);
  });
  it('ignores normal work', () => {
    expect(isIncident(ctx())).toBe(false);
  });
  it('ignores private and missing contexts', () => {
    expect(isIncident(ctx({ windowTitle: 'outage', private: true }))).toBe(false);
    expect(isIncident(undefined)).toBe(false);
  });
});
