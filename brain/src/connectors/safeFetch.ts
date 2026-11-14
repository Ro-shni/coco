import { isDeniedHost } from './hosts.js';

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

const urlOf = (input: string | URL): string => (typeof input === 'string' ? input : input.toString());

/** Wraps fetch so no connector traffic — MCP requests, OAuth metadata discovery, token exchange — can reach a
 * production host, whatever a server's metadata points at. */
export function safeFetch(inner: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    if (isDeniedHost(urlOf(input))) throw new Error('refused: production host');
    return inner(input, init);
  };
}

/** A sign-in page Studio will link to: it comes from server-supplied metadata, so it must be https and not a
 * production host (no http phishing pages, file:, smb: or custom schemes). */
export function assertSafeAuthUrl(url: URL): void {
  if (url.protocol !== 'https:') throw new Error('refused: sign-in URL must be https');
  if (isDeniedHost(url.toString())) throw new Error('refused: production host');
}
