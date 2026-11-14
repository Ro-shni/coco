import { describe, expect, it } from 'vitest';
import { isKnownSiteResult, parseSiteCommand } from '../src/sites.js';

describe('parseSiteCommand', () => {
  it.each([
    ['open youtube', { type: 'open_url', url: 'https://www.youtube.com', label: 'YouTube' }],
    ['go to youtube', { type: 'open_url', url: 'https://www.youtube.com', label: 'YouTube' }],
    ['open gmail', { type: 'open_url', url: 'https://mail.google.com', label: 'Gmail' }],
    ['open github', { type: 'open_url', url: 'https://github.com', label: 'GitHub' }],
    ['open google', { type: 'open_url', url: 'https://www.google.com', label: 'Google' }],
    [
      'search youtube for aditya verma dynamic programming',
      { type: 'open_url', url: 'https://www.youtube.com/results?search_query=aditya%20verma%20dynamic%20programming', label: 'aditya verma dynamic programming on YouTube' },
    ],
    [
      'search dynamic programming on youtube',
      { type: 'open_url', url: 'https://www.youtube.com/results?search_query=dynamic%20programming', label: 'dynamic programming on YouTube' },
    ],
    [
      'play dynamic programming on youtube',
      { type: 'open_url', url: 'https://www.youtube.com/results?search_query=dynamic%20programming', label: 'dynamic programming on YouTube' },
    ],
    [
      'open youtube and search dynamic programming',
      { type: 'open_url', url: 'https://www.youtube.com/results?search_query=dynamic%20programming', label: 'dynamic programming on YouTube' },
    ],
    [
      'open youtube in chrome',
      { type: 'open_url', url: 'https://www.youtube.com', label: 'YouTube', browser: 'chrome' },
    ],
    [
      'search dynamic programming on youtube in arc',
      { type: 'open_url', url: 'https://www.youtube.com/results?search_query=dynamic%20programming', label: 'dynamic programming on YouTube', browser: 'arc' },
    ],
    ['open github.com/foo', { type: 'open_url', url: 'https://github.com/foo', label: 'github.com/foo' }],
    // M2: a dotted target is only a website with an explicit scheme or an allowlisted TLD — otherwise it
    // falls through (null here) so commands.ts's app-focus parsing handles it instead.
    ['open readme.md', null],
    ['open zoom.us', null],
    ['open example.com', { type: 'open_url', url: 'https://example.com', label: 'example.com' }],
    ['open example.org', { type: 'open_url', url: 'https://example.org', label: 'example.org' }],
    ['open example.ai', { type: 'open_url', url: 'https://example.ai', label: 'example.ai' }],
    ['open https://example.org/path', { type: 'open_url', url: 'https://example.org/path', label: 'https://example.org/path' }],
    ['search google for dynamic programming', { type: 'open_url', url: 'https://www.google.com/search?q=dynamic%20programming', label: 'dynamic programming on Google' }],
    ['search github for coco', { type: 'open_url', url: 'https://github.com/search?q=coco', label: 'coco on GitHub' }],
    // gmail has no search template, in either phrasing
    ['search gmail for invoices', null],
    ['search invoices on gmail', null],
    // not a known site, not a domain
    ['open slack', null],
    ['open my terminal', null],
    ['go to grafana', null],
    ['open the pod logs for widget-feed-resolver in prd', null],
    ['', null],

    // Compound-commands-trace brief, requirement 1: "<site> on|in <destination>" -> open_url for the site.
    // "google"/"the web"/"browser" mean the default browser (no `browser` field); a real browser name sets it.
    ['open gmail on google', { type: 'open_url', url: 'https://mail.google.com', label: 'Gmail' }],
    ['open gmail on the web', { type: 'open_url', url: 'https://mail.google.com', label: 'Gmail' }],
    ['open gmail on browser', { type: 'open_url', url: 'https://mail.google.com', label: 'Gmail' }],
    ['open gmail on chrome', { type: 'open_url', url: 'https://mail.google.com', label: 'Gmail', browser: 'chrome' }],
    ['open gmail in chrome', { type: 'open_url', url: 'https://mail.google.com', label: 'Gmail', browser: 'chrome' }],
    ['go to youtube on arc', { type: 'open_url', url: 'https://www.youtube.com', label: 'YouTube', browser: 'arc' }],
    // notion isn't a known site (or a domain), so the destination suffix alone isn't enough to open anything.
    ['open notion on chrome', null],

    // Requirement 2: "open|launch <browser-ish word> and (type|search|search for|look up|go to|open) <X>".
    // X naming a known site (or domain) opens it directly; otherwise it's a Google search for X. Commas and
    // quotes around X are stripped. Only a real browser name (not "google"/"browser") sets `browser`.
    ['open google and type, gmail', { type: 'open_url', url: 'https://mail.google.com', label: 'Gmail' }],
    ['open chrome and type, gmail', { type: 'open_url', url: 'https://mail.google.com', label: 'Gmail', browser: 'chrome' }],
    ['launch browser and search for gmail', { type: 'open_url', url: 'https://mail.google.com', label: 'Gmail' }],
    ['open chrome and go to "github.com"', { type: 'open_url', url: 'https://github.com', label: 'github.com', browser: 'chrome' }],
    [
      'open chrome and look up dynamic programming',
      { type: 'open_url', url: 'https://www.google.com/search?q=dynamic%20programming', label: 'dynamic programming on Google', browser: 'chrome' },
    ],
    [
      'open google and open dynamic programming',
      { type: 'open_url', url: 'https://www.google.com/search?q=dynamic%20programming', label: 'dynamic programming on Google' },
    ],
    // "open <app> and <anything else>" where app isn't a browser -> null (fall through to the model).
    ['open slack and say hi', null],
  ] as const)('%s', (text, expected) => {
    expect(parseSiteCommand(text)).toEqual(expected);
  });
});

describe('isKnownSiteResult', () => {
  it.each([
    'https://www.youtube.com',
    'https://mail.google.com',
    'https://github.com',
    'https://www.google.com',
    'https://www.youtube.com/results?search_query=dynamic%20programming',
    'https://www.google.com/search?q=x',
    'https://github.com/search?q=x',
  ])('is true for a known site homepage or search-template result: %s', (url) => {
    expect(isKnownSiteResult(url)).toBe(true);
  });

  it.each([
    'https://www.youtube.com/watch?v=xyz',
    'https://evil.example.com/login',
    'https://github.com/Ro-shni/Coco',
    'https://example.com',
    'not a url at all',
  ])('is false for anything else, even on a known host: %s', (url) => {
    expect(isKnownSiteResult(url)).toBe(false);
  });

  // N2: a plain startsWith(prefix) let anything ride along after the query param — closing that.
  it.each([
    ['https://www.google.com/search?q=evil&btnI=1', "extra param (Google's I'm Feeling Lucky redirect)"],
    ['https://www.google.com/search?q=evil&foo=bar', 'a different extra param'],
    ['https://github.com/search?q=x&type=code', 'an extra github search param'],
    ['https://www.youtube.com/results?search_query=x&list=PL123', 'an extra youtube playlist param'],
    ['https://www.youtube.com#foo', 'a fragment on the homepage'],
    ['https://www.youtube.com/results?search_query=x#foo', 'a fragment on a search result'],
    ['https://youtube.com@evil.com/results?search_query=x', 'userinfo trick — the real host is evil.com'],
    ['https://www.youtube.com:8443', 'a different port than the known origin'],
    ['https://www.google.com/search', 'no query param at all on a search path'],
    ['https://www.google.com/search?x=1', 'the wrong query param name'],
  ])('N2: is false for %s (%s)', (url) => {
    expect(isKnownSiteResult(url)).toBe(false);
  });

  it('N2: is still true for a search result with exactly the template query param and nothing else', () => {
    expect(isKnownSiteResult('https://www.google.com/search?q=dynamic+programming')).toBe(true);
    expect(isKnownSiteResult('https://www.youtube.com/')).toBe(true); // trailing slash homepage
  });
});
