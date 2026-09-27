export interface SiteCommand {
  type: 'open_url';
  url: string;
  label: string;
  browser?: string;
}

/** Site name -> its home page. "slack" is deliberately absent: Slack is an app, not a website Coco should open. */
const KNOWN_SITES: Readonly<Record<string, string>> = {
  youtube: 'https://www.youtube.com',
  gmail: 'https://mail.google.com',
  github: 'https://github.com',
  google: 'https://www.google.com',
};

/** Display name for a known site key, used in confirmation text ("Opening YouTube…"). */
const SITE_LABELS: Readonly<Record<string, string>> = {
  youtube: 'YouTube',
  gmail: 'Gmail',
  github: 'GitHub',
  google: 'Google',
};

/** Site name -> its search URL template. Not every known site has one (gmail doesn't). */
const SEARCH_TEMPLATES: Readonly<Record<string, (query: string) => string>> = {
  youtube: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  github: (q) => `https://github.com/search?q=${encodeURIComponent(q)}`,
};
/** The exact URL *prefix* each search template produces (before the query), so `isKnownSiteResult` can
 * recognise "our own" search-result URLs without re-deriving the query. */
const SEARCH_PREFIXES: readonly string[] = [
  'https://www.youtube.com/results?search_query=',
  'https://www.google.com/search?q=',
  'https://github.com/search?q=',
];

const BROWSERS = ['chrome', 'safari', 'arc', 'firefox', 'brave', 'edge'] as const;
const BROWSER_SUFFIX = new RegExp(`\\s+in\\s+(${BROWSERS.join('|')})$`, 'i');

/** A bare domain, optionally with a path, e.g. "github.com" or "github.com/foo/bar". No spaces, needs a dot. */
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(?:\/\S*)?$/i;
/** An explicit http(s) URL the user typed verbatim, e.g. "open https://example.org/path". */
const EXPLICIT_URL = /^https?:\/\//i;
/** M2: a bare dotted target ("readme.md", "zoom.us") is only treated as a website when its TLD is one of
 * these — otherwise it's far more likely a filename or an app name (the Zoom app is literally "zoom.us")
 * and is left for app-focus/launch to handle instead. An explicit scheme (`EXPLICIT_URL`) always wins. */
const WEBSITE_TLDS = new Set(['com', 'org', 'net', 'io', 'dev', 'in', 'co', 'ai', 'app', 'gov', 'edu']);

const SEARCH_FOR = /^search\s+([a-z][a-z0-9]*)\s+for\s+(.+)$/i;
const OPEN_AND_SEARCH = /^open\s+([a-z][a-z0-9]*)\s+and\s+search\s+(.+)$/i;
const SEARCH_OR_PLAY_ON = /^(?:search|play)\s+(.+?)\s+on\s+([a-z][a-z0-9]*)$/i;
const OPEN_OR_GO_TO = /^(?:open|go\s+to)\s+(.+)$/i;

function siteLabel(site: string): string {
  return SITE_LABELS[site] ?? site;
}

function searchCommand(site: string, query: string): SiteCommand | null {
  const template = SEARCH_TEMPLATES[site];
  const trimmedQuery = query.trim();
  if (!template || !trimmedQuery) return null;
  return { type: 'open_url', url: template(trimmedQuery), label: `${trimmedQuery} on ${siteLabel(site)}` };
}

/**
 * Recognises "open youtube", "go to github", "search youtube for X", "search X on youtube",
 * "play X on youtube", "open youtube and search X", an explicit domain/URL ("github.com/foo"), and an
 * optional trailing "in chrome|safari|arc|firefox|brave|edge". Expects text already lowercased and
 * stripped of Coco-address prefixes/trailing punctuation (as commands.ts does before calling this).
 * Returns null for anything else, including known sites with no search template (e.g. "search gmail for x").
 */
export function parseSiteCommand(text: string): SiteCommand | null {
  let s = text.trim();
  if (!s) return null;

  let browser: string | undefined;
  const browserMatch = s.match(BROWSER_SUFFIX);
  if (browserMatch) {
    browser = browserMatch[1]!.toLowerCase();
    s = s.slice(0, browserMatch.index).trim();
  }

  const cmd = matchCommand(s);
  if (!cmd) return null;
  return browser ? { ...cmd, browser } : cmd;
}

function matchCommand(s: string): SiteCommand | null {
  const searchFor = s.match(SEARCH_FOR) ?? s.match(OPEN_AND_SEARCH);
  if (searchFor) {
    const found = searchCommand(searchFor[1]!.toLowerCase(), searchFor[2]!);
    if (found) return found;
  }

  const searchOrPlayOn = s.match(SEARCH_OR_PLAY_ON);
  if (searchOrPlayOn) {
    const found = searchCommand(searchOrPlayOn[2]!.toLowerCase(), searchOrPlayOn[1]!);
    if (found) return found;
  }

  const openOrGoTo = s.match(OPEN_OR_GO_TO);
  if (openOrGoTo) {
    const target = openOrGoTo[1]!.trim();
    const site = target.toLowerCase();
    const knownUrl = KNOWN_SITES[site];
    if (knownUrl) return { type: 'open_url', url: knownUrl, label: siteLabel(site) };
    const url = websiteUrl(target);
    if (url) return { type: 'open_url', url, label: target };
  }

  return null;
}

/** Resolves a domain-shaped target to a URL, or null when it should be left for app-focus/launch instead
 * (M2: a bare dotted name is a website only with an explicit scheme or an allowlisted TLD). */
function websiteUrl(target: string): string | null {
  if (EXPLICIT_URL.test(target)) return target;
  if (!DOMAIN.test(target)) return null;
  const host = target.split('/')[0]!;
  const tld = host.split('.').pop()?.toLowerCase();
  return tld && WEBSITE_TLDS.has(tld) ? `https://${target}` : null;
}

/**
 * True when `url` is exactly a known site's homepage, or matches the shape of one of our own search
 * templates' output (same prefix). Used to decide whether a MODEL-proposed url action is safe to open
 * automatically, or should be confirmed first (M7) — an arbitrary URL on a known host that isn't one of
 * these two shapes (e.g. a specific YouTube video) does not qualify.
 */
export function isKnownSiteResult(url: string): boolean {
  return Object.values(KNOWN_SITES).includes(url) || SEARCH_PREFIXES.some((prefix) => url.startsWith(prefix));
}
