import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import type { Logger } from '../logger.js';
import { handleApi, type ApiDeps } from './api.js';
import { checkRequest, launchCookie } from './auth.js';

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

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...SECURITY_HEADERS, ...extra }).end(body);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolveBody(undefined);
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

export function createStudioHandler(opts: {
  token: string; staticDir: string; api: ApiDeps; log: Logger;
  oauthCallback?: (query: URLSearchParams) => Promise<{ status: number; html: string }>;
}): (req: IncomingMessage, res: ServerResponse, port: number) => void {
  const root = existsSync(opts.staticDir) ? realpathSync(opts.staticDir) : resolve(opts.staticDir);
  return (req, res, port) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const path = url.pathname;
      try {
        if (path === '/oauth/callback' && opts.oauthCallback) {
          const r = await opts.oauthCallback(url.searchParams); // state-validated inside; no cookie (browser redirect)
          return send(res, r.status, r.html, TYPES['.html']!);
        }
        if (path === '/studio/launch') {
          const probe = checkRequest({ headers: { ...req.headers, authorization: `Bearer ${url.searchParams.get('t') ?? ''}` } }, opts.token, port);
          if (!probe.ok) return send(res, probe.status, 'Unauthorized', 'text/plain');
          return send(res, 302, '', 'text/plain', { location: '/studio/', 'set-cookie': launchCookie(opts.token) });
        }
        const check = checkRequest(req, opts.token, port);
        if (!check.ok) {
          opts.log.warn('studio_rejected', { reason: check.reason });
          return send(res, check.status, JSON.stringify({ error: check.reason }), TYPES['.json']!);
        }
        if (path.startsWith('/api/')) {
          let body: unknown;
          try { body = await readBody(req); } catch (e) { return send(res, 400, JSON.stringify({ error: (e as Error).message }), TYPES['.json']!); }
          const r = await handleApi({ method: req.method ?? 'GET', path, query: url.searchParams, body }, opts.api);
          return send(res, r.status, JSON.stringify(r.json), TYPES['.json']!);
        }
        if (path === '/studio' || path.startsWith('/studio/')) {
          const rel = decodeURIComponent(path.slice('/studio'.length)) || '/';
          if (rel.includes('\0')) return send(res, 400, 'Bad path', 'text/plain');
          const candidate = resolve(join(root, rel));
          if (candidate !== root && !candidate.startsWith(root + sep)) return send(res, 404, 'Not found', 'text/plain');
          const file = existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(root, 'index.html');
          if (!existsSync(file)) return send(res, 404, 'Studio is not built', 'text/plain');
          return send(res, 200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream');
        }
        return send(res, 404, 'Not found', 'text/plain');
      } catch {
        opts.log.error('studio_error');
        if (!res.headersSent) send(res, 500, 'Internal error', 'text/plain');
      }
    })();
  };
}
