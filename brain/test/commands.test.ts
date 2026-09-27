import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/commands.js';

describe('parseCommand', () => {
  it.each([
    ['go to slack', { type: 'focus', target: 'slack', kind: 'app' }],
    ['Coco, switch to VS Code please.', { type: 'focus', target: 'vs code', kind: 'app' }],
    ['bring up the grafana tab', { type: 'focus', target: 'grafana', kind: 'window' }],
    ['open my terminal', { type: 'focus', target: 'terminal', kind: 'app' }],
    ['back to chrome!', { type: 'focus', target: 'chrome', kind: 'app' }],
    ['focus on the devops-rca window', { type: 'focus', target: 'devops-rca', kind: 'window' }],
    ['show me what\'s wrong with this code', null],
    ['can you open it', null],
    ['open the pod logs for widget-feed-resolver in prd', null],
    ['what is this', null],
    ['hello', null],
    ['go to', null],
    // M2: a bare dotted target is a website only with an explicit scheme or an allowlisted TLD.
    ['open readme.md', { type: 'focus', target: 'readme.md', kind: 'app' }],
    ['open zoom.us', { type: 'focus', target: 'zoom.us', kind: 'app' }],
    ['open github.com/x', { type: 'open_url', url: 'https://github.com/x', label: 'github.com/x' }],
  ] as const)('%s', (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });

  it('M3: preserves the original case of a URL path (only the site-name lookup is case-insensitive)', () => {
    expect(parseCommand('open github.com/Ro-shni/Coco')).toEqual({
      type: 'open_url',
      url: 'https://github.com/Ro-shni/Coco',
      label: 'github.com/Ro-shni/Coco',
    });
  });

  it('M3: still resolves a known site by name regardless of case', () => {
    expect(parseCommand('Open YouTube')).toEqual({ type: 'open_url', url: 'https://www.youtube.com', label: 'YouTube' });
  });

  it("N6: a '?' inside an http(s) URL's query string doesn't count as a bare question mark", () => {
    expect(parseCommand('open https://x.com/?a=1')).toEqual({
      type: 'open_url',
      url: 'https://x.com/?a=1',
      label: 'https://x.com/?a=1',
    });
    expect(parseCommand('open https://example.com/search?q=1&b=2')).toEqual({
      type: 'open_url',
      url: 'https://example.com/search?q=1&b=2',
      label: 'https://example.com/search?q=1&b=2',
    });
  });

  it('N6: a genuine question (not a URL) is still rejected when the "?" is not at the end', () => {
    expect(parseCommand('open the pod logs for widget-feed-resolver in prd')).toBeNull();
    expect(parseCommand('is this the right window? go to slack')).toBeNull();
  });
});
