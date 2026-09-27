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
/** The origin, path and single query-param key each search template produces — kept in lockstep with
 * SEARCH_TEMPLATES above (add a row here whenever a template is added there) — so `isKnownSiteResult`
 * (N2) can recognise "our own" search-result URLs by shape, without a loose `startsWith` that would let
 * anything ride along after the query (e.g. Google's `&btnI=1` "I'm Feeling Lucky" redirect). */
const SEARCH_URL_SHAPES: readonly { origin: string; pathname: string; queryKey: string }[] = [
  { origin: 'https://www.youtube.com', pathname: '/results', queryKey: 'search_query' },
  { origin: 'https://www.google.com', pathname: '/search', queryKey: 'q' },
  { origin: 'https://github.com', pathname: '/search', queryKey: 'q' },
];

const BROWSERS = ['chrome', 'safari', 'arc', 'firefox', 'brave', 'edge'] as const;
const BROWSER_SUFFIX = new RegExp(`\\s+in\\s+(${BROWSERS.join('|')})$`, 'i');

/** Generic destination words that mean "the default browser" rather than naming one — usable after
 * "<site> on|in <destination>" (requirement 1) alongside a real browser name. */
const GENERIC_DESTINATIONS = ['google', 'the web', 'browser'] as const;
const SITE_DESTINATIONS = [...GENERIC_DESTINATIONS, ...BROWSERS];
/** "open|go to <site> on|in <destination>" — a single-word site immediately followed by an on/in
 * destination clause, e.g. "open gmail on google" or "open gmail on chrome". Only tried when the old
 * BROWSER_SUFFIX pre-strip above (real browsers + "in" only) hasn't already consumed the suffix. */
const OPEN_SITE_ON_DESTINATION = new RegExp(
  `^(?:open|go\\s+to)\\s+([a-z][a-z0-9]*)\\s+(?:on|in)\\s+(${SITE_DESTINATIONS.join('|')})$`,
  'i',
);

/** Launcher words allowed before "and <verb> <X>" (requirement 2) — real browsers plus the two generic
 * words. No "the web" here: "open the web and type X" isn't idiomatic phrasing. */
const LAUNCHER_WORDS = ['google', ...BROWSERS, 'browser'] as const;
const LAUNCH_VERB = 'type|search\\s+for|search|look\\s+up|go\\s+to|open';
/** "open|launch <launcher> and (type|search|search for|look up|go to|open) <X>", with an optional comma
 * right after the verb ("...and type, gmail"). */
const OPEN_LAUNCHER_AND_X = new RegExp(
  `^(?:open|launch)\\s+(${LAUNCHER_WORDS.join('|')})\\s+and\\s+(?:${LAUNCH_VERB})[,]?\\s+(.+)$`,
  'i',
);

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

/** Resolves a target to a website: a known site by name, or a domain/URL (M2's TLD allowlist / explicit
 * scheme rule) — otherwise null so the caller can leave it for app-focus/launch instead. */
function resolveSite(target: string): SiteCommand | null {
  const site = target.toLowerCase();
  const knownUrl = KNOWN_SITES[site];
  if (knownUrl) return { type: 'open_url', url: knownUrl, label: siteLabel(site) };
  const url = websiteUrl(target);
  return url ? { type: 'open_url', url, label: target } : null;
}

/** Strips a single leading/trailing comma or quote (and surrounding whitespace) — requirement 2's
 * "strip commas/quotes around X" (e.g. the X captured from "...and type, Gmail" or '...and go to "X"'). */
function stripSurroundingPunctuation(s: string): string {
  return s.trim().replace(/^[,"']+/, '').replace(/[,"']+$/, '').trim();
}

function matchCommand(s: string): SiteCommand | null {
  // Requirement 1: "open|go to <site> on|in <destination>" — a known/domain site with an explicit
  // destination (a real browser, or "google"/"the web"/"browser" for the default browser). Falls through
  // (not an early return) when the site part doesn't resolve, e.g. "open notion on chrome".
  const openSiteOnDestination = s.match(OPEN_SITE_ON_DESTINATION);
  if (openSiteOnDestination) {
    const resolved = resolveSite(openSiteOnDestination[1]!);
    if (resolved) {
      const destination = openSiteOnDestination[2]!.toLowerCase();
      const isBrowser = (BROWSERS as readonly string[]).includes(destination);
      return isBrowser ? { ...resolved, browser: destination } : resolved;
    }
  }

  // Requirement 2: "open|launch <browser-ish word> and (type|search|...|open) <X>" — X naming a known
  // site/domain opens it directly; otherwise it's a Google search for X. Falls through when X is empty
  // after stripping punctuation (shouldn't happen given the regex, but be defensive).
  const openLauncherAndX = s.match(OPEN_LAUNCHER_AND_X);
  if (openLauncherAndX) {
    const launcher = openLauncherAndX[1]!.toLowerCase();
    const x = stripSurroundingPunctuation(openLauncherAndX[2]!);
    if (x) {
      const resolved = resolveSite(x) ?? searchCommand('google', x);
      if (resolved) {
        const isBrowser = (BROWSERS as readonly string[]).includes(launcher);
        return isBrowser ? { ...resolved, browser: launcher } : resolved;
      }
    }
  }

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
    const resolved = resolveSite(openOrGoTo[1]!.trim());
    if (resolved) return resolved;
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
 * templates' output — same origin, same path, and EXACTLY the one query param that template uses (no
 * extras, no fragment). Used to decide whether a MODEL-proposed url action is safe to open automatically,
 * or should be confirmed first (M7) — an arbitrary URL on a known host that isn't one of these two exact
 * shapes (e.g. a specific YouTube video, or a search with an extra `&btnI=1` "I'm Feeling Lucky" redirect
 * riding along) does not qualify. `URL.origin` also defeats userinfo tricks (`https://youtube.com@evil.com`
 * has origin `https://evil.com`, not youtube.com) and a different port.
 */
export function isKnownSiteResult(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hash) return false;

  const isHomepage = Object.values(KNOWN_SITES).some((homepage) => {
    const h = new URL(homepage);
    return parsed.origin === h.origin && parsed.pathname === h.pathname && parsed.search === '';
  });
  if (isHomepage) return true;

  return SEARCH_URL_SHAPES.some((shape) => {
    if (parsed.origin !== shape.origin || parsed.pathname !== shape.pathname) return false;
    const keys = [...parsed.searchParams.keys()];
    return keys.length === 1 && keys[0] === shape.queryKey;
  });
}
