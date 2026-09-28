import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import { handleApi, type ApiDeps } from './api.js';
import { checkHost, checkHostAndOrigin, checkRequest, randomToken, safeEq } from './auth.js';
import type { SessionStore } from './sessions.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2',
};
const MAX_BODY = 256 * 1024;
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};
const SessionBody = z.object({ nonce: z.string().min(1) });
// N1: `n` is echoed into an inline script below; only ever render a value shaped like the 64-hex-char launch
// nonce this same process minted (see sessions.ts: 32 bytes -> 64 hex chars). Anything else renders the
// "link expired" state instead, so no attacker-controlled string ever reaches the page.
const LAUNCH_NONCE = /^[0-9a-f]{64}$/;

class BodyTooLargeError extends Error {}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...SECURITY_HEADERS, ...extra }).end(body);
}
const sendJson = (res: ServerResponse, status: number, json: unknown, extra: Record<string, string> = {}): void =>
  send(res, status, JSON.stringify(json), TYPES['.json']!, extra);

// M2: on an oversize body, keep draining the request (the 'data' listener below stays attached, so Node still
// reads and discards the remaining bytes) instead of destroying the socket — the client then actually receives
// the 413 JSON body instead of an ECONNRESET/EPIPE.
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    req.on('data', (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY) return fail(new BodyTooLargeError('body too large'));
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      if (chunks.length === 0) return resolveBody(undefined);
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        fail(new Error('invalid json'));
      }
    });
    req.on('error', fail);
  });
}

async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await readBody(req) };
  } catch (e) {
    if (e instanceof BodyTooLargeError) sendJson(res, 413, { error: 'body too large' });
    else sendJson(res, 400, { error: (e as Error).message });
    return { ok: false };
  }
}

const EXPIRED_BODY = 'This Studio link has expired — reopen Studio from the Coco menu.';

/** The tiny page served at /studio/launch. Its only script consumes the launch nonce and stores the resulting
 * session token in sessionStorage (never a cookie, never sent to any other 127.0.0.1 port). `cspNonce` is a
 * fresh per-response value so the CSP can allow exactly this inline script and nothing else.
 *
 * N1: `nonce` is `undefined` unless it already matched `LAUNCH_NONCE`, so this function never has to sanitize
 * or reason about attacker-controlled content — an unmatched value simply renders the "link expired" state. */
function launchPage(nonce: string | undefined, cspNonce: string): string {
  if (!nonce) {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Coco Studio</title></head>
<body>${EXPIRED_BODY}</body></html>`;
  }
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Coco Studio</title></head>
<body>
<script nonce="${cspNonce}">
(async () => {
  try {
    const res = await fetch('/studio/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: ${JSON.stringify(nonce)} }),
    });
    if (!res.ok) throw new Error('session exchange failed');
    const data = await res.json();
    sessionStorage.setItem('coco_studio_session', data.token);
    location.replace('/studio/');
  } catch (e) {
    document.body.textContent = ${JSON.stringify(EXPIRED_BODY)};
  }
})();
</script>
</body></html>`;
}

export function createStudioHandler(opts: {
  token: string; staticDir: string; api: ApiDeps; log: Logger; sessions: SessionStore;
  oauthCallback?: (query: URLSearchParams) => Promise<{ status: number; html: string }>;
}): (req: IncomingMessage, res: ServerResponse, port: number) => void {
  const root = existsSync(opts.staticDir) ? realpathSync(opts.staticDir) : resolve(opts.staticDir);
  const isPrimaryToken = (t: string) => safeEq(t, opts.token);
  const isValidApiToken = (t: string) => isPrimaryToken(t) || opts.sessions.isValidSession(t);

  return (req, res, port) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const path = url.pathname;
      try {
        // I5: the OAuth redirect always carries a correct Host; nothing else should be able to reach this
        // (and its future state-handling) under a DNS-rebound Host.
        if (path === '/oauth/callback' && opts.oauthCallback) {
          const hostCheck = checkHost(req.headers, port);
          if (!hostCheck.ok) return sendJson(res, hostCheck.status, { error: hostCheck.reason });
          const r = await opts.oauthCallback(url.searchParams);
          return send(res, r.status, r.html, TYPES['.html']!);
        }

        // Body-only: mints a one-time launch nonce. Requires the permanent Studio token specifically —
        // a session token (scoped to one already-open Studio tab) must never be able to mint fresh launch links.
        if (path === '/api/launch-nonce' && req.method === 'POST') {
          const check = checkRequest(req.headers, port, isPrimaryToken);
          if (!check.ok) return sendJson(res, check.status, { error: check.reason });
          return sendJson(res, 200, { nonce: opts.sessions.createNonce() });
        }

        // I1+I2: no cookie, no long-lived token in the URL. Always renders (Host-checked only); the nonce is
        // validated by the page's own script against /studio/session, so an expired/garbage `n` just shows
        // the "reopen Studio" message client-side rather than needing server-side branching here.
        if (path === '/studio/launch') {
          const hostCheck = checkHost(req.headers, port);
          if (!hostCheck.ok) return send(res, hostCheck.status, 'Forbidden', 'text/plain');
          const raw = url.searchParams.get('n') ?? '';
          const n = LAUNCH_NONCE.test(raw) ? raw : undefined; // N1: never echo an unvalidated value into the page
          const cspNonce = randomToken(16);
          return send(res, 200, launchPage(n, cspNonce), TYPES['.html']!, {
            'content-security-policy': `default-src 'none'; script-src 'nonce-${cspNonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
          });
        }

        // Exchanges a one-time nonce for a session token. Host+Origin checked like any browser-originated
        // mutation; no bearer token is required (or possible) here — the nonce itself is the credential.
        if (path === '/studio/session' && req.method === 'POST') {
          const check = checkHostAndOrigin(req.headers, port);
          if (!check.ok) return sendJson(res, check.status, { error: check.reason });
          const read = await readJsonBody(req, res);
          if (!read.ok) return;
          const parsed = SessionBody.safeParse(read.body);
          if (!parsed.success) return sendJson(res, 400, { error: 'nonce is required' });
          const token = opts.sessions.consumeNonce(parsed.data.nonce);
          if (!token) return sendJson(res, 401, { error: 'expired' });
          return sendJson(res, 200, { token });
        }

        if (path.startsWith('/api/')) {
          const check = checkRequest(req.headers, port, isValidApiToken);
          if (!check.ok) {
            opts.log.warn('studio_rejected', { reason: check.reason });
            return sendJson(res, check.status, { error: check.reason });
          }
          const read = await readJsonBody(req, res);
          if (!read.ok) return;
          const r = await handleApi({ method: req.method ?? 'GET', path, query: url.searchParams, body: read.body }, opts.api);
          return sendJson(res, r.status, r.json);
        }

        if (path === '/studio' || path.startsWith('/studio/')) {
          // Static assets carry no secrets; the Host check alone (no token, no Origin) is enough here.
          const hostCheck = checkHost(req.headers, port);
          if (!hostCheck.ok) return send(res, hostCheck.status, 'Forbidden', 'text/plain');
          let rel: string;
          try {
            rel = decodeURIComponent(path.slice('/studio'.length)) || '/'; // M1
          } catch {
            return send(res, 400, 'Bad path', 'text/plain');
          }
          if (rel.includes('\0')) return send(res, 400, 'Bad path', 'text/plain');
          // M4: reject dotfile/traversal segments outright (also catches `..` before it ever reaches resolve()).
          if (rel.split('/').some((s) => s.startsWith('.') && s !== '')) return send(res, 404, 'Not found', 'text/plain');
          const candidate = resolve(join(root, rel));
          if (candidate !== root && !candidate.startsWith(root + sep)) return send(res, 404, 'Not found', 'text/plain');
          let file: string;
          if (existsSync(candidate) && statSync(candidate).isFile()) {
            // M4: a symlink inside staticDir pointing outside it must not be followed.
            const real = realpathSync(candidate);
            if (real !== root && !real.startsWith(root + sep)) return send(res, 404, 'Not found', 'text/plain');
            file = real;
          } else {
            file = join(root, 'index.html'); // SPA fallback
          }
          if (!existsSync(file)) return send(res, 404, 'Studio is not built', 'text/plain');
          return send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
        }

        return send(res, 404, 'Not found', 'text/plain');
      } catch (e) {
        // M5: never log the message (it can carry a value); name/code are enough to diagnose from the logs.
        const error = e as NodeJS.ErrnoException;
        opts.log.error('studio_error', { name: error.name, code: error.code });
        if (!res.headersSent) send(res, 500, 'Internal error', 'text/plain');
      }
    })();
  };
}
