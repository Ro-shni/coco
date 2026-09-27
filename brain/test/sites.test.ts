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
  ])('is false for anything else, even on a known host: %s', (url) => {
    expect(isKnownSiteResult(url)).toBe(false);
  });
});
