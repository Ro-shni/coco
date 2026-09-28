import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '../logger.js';

/** Default fixed loopback port for OAuth redirects. The brain's own port is ephemeral, but a redirect URI has to
 * stay the same across restarts: pre-registered apps (Slack) list it exactly, and dynamically registered clients
 * are saved with it. */
export const DEFAULT_OAUTH_CALLBACK_PORT = 47823;

export interface OAuthCallbackServer {
  port: number;
  close(): Promise<void>;
}

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

/** A tiny HTTP listener on 127.0.0.1 that serves only `GET /oauth/callback`. Rejects with "port … in use" when
 * the port is taken, so the caller can log it and keep running without sign-in. */
export function startOAuthCallbackServer(opts: {
  port: number;
  log: Logger;
  handle: (query: URLSearchParams) => Promise<{ status: number; html: string }>;
}): Promise<OAuthCallbackServer> {
  let boundPort = opts.port;
  const http = createServer((req, res) => {
    void (async () => {
      const send = (status: number, html: string) => res.writeHead(status, HEADERS).end(html);
      if (req.headers.host !== `127.0.0.1:${boundPort}`) return send(403, 'Forbidden');
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);
      if (req.method !== 'GET' || url.pathname !== '/oauth/callback') return send(404, 'Not found');
      try {
        const r = await opts.handle(url.searchParams);
        send(r.status, r.html);
      } catch (err) {
        opts.log.error('oauth_callback_error', { error: (err as Error).name });
        if (!res.headersSent) send(500, 'Internal error');
      }
    })();
  });
  return new Promise((resolve, reject) => {
    http.once('error', (err: NodeJS.ErrnoException) => {
      reject(new Error(err.code === 'EADDRINUSE' ? `OAuth callback port ${opts.port} is in use` : `OAuth callback server failed: ${err.code ?? err.name}`));
    });
    http.listen(opts.port, '127.0.0.1', () => {
      boundPort = (http.address() as AddressInfo).port;
      resolve({ port: boundPort, close: () => new Promise<void>((done) => http.close(() => done())) });
    });
  });
}
