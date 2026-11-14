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
    // Compound-commands-trace brief: "Can you open Mail?" still focuses the app (unchanged).
    ['Can you open Mail?', { type: 'focus', target: 'mail', kind: 'app' }],
    // "<site> on|in <google|the web|browser|chrome|…>" -> open_url for the site. "on google"/"the web"/
    // "browser" mean the default browser (no `browser` field); a real browser name sets it.
    ['Open Gmail on Google', { type: 'open_url', url: 'https://mail.google.com', label: 'Gmail' }],
    // "open|launch <browser-ish word> and (type|search|search for|look up|go to|open) <X>": X is a known
    // site -> open_url that site; commas/quotes around X are stripped.
    ['Open Google and type, Gmail', { type: 'open_url', url: 'https://mail.google.com', label: 'Gmail' }],
    ['Open chrome and type, Gmail', { type: 'open_url', url: 'https://mail.google.com', label: 'Gmail', browser: 'chrome' }],
    // Regression: app names that aren't known sites still focus normally, even when the whole remainder
    // (verb + rest) would otherwise look like a compound command.
    ['open slack', { type: 'focus', target: 'slack', kind: 'app' }],
    ['open code', { type: 'focus', target: 'code', kind: 'app' }],
    ['go to the release notes', { type: 'focus', target: 'release notes', kind: 'app' }],
    // notion isn't a known site, so "in chrome" is just a stray connector word in an app target -> null,
    // not a guess at either focus or open_url.
    ['open notion in chrome', null],
    ['search youtube for aditya dp in arc', {
      type: 'open_url',
      url: 'https://www.youtube.com/results?search_query=aditya%20dp',
      label: 'aditya dp on YouTube',
      browser: 'arc',
    }],
  ] as const)('%s', (text, expected) => {
    expect(parseCommand(text)).toEqual(expected);
  });

  it('drops a trailing "for me" so it never becomes part of the app name', () => {
    expect(parseCommand('open slack for me')).toEqual({ type: 'focus', target: 'slack', kind: 'app' });
    expect(parseCommand('can you open mail for me please?')).toEqual({ type: 'focus', target: 'mail', kind: 'app' });
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
