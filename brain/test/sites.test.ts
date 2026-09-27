import { describe, expect, it } from 'vitest';
import { parseSiteCommand } from '../src/sites.js';

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
