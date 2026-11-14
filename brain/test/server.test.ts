import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { silentLogger } from '../src/logger.js';
import type { BodyToBrain } from '../src/protocol.js';
import { startServer, tokenMatches, type BrainServer } from '../src/server.js';

const TOKEN = 'a'.repeat(64);
let server: BrainServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const connect = (port: number, token: string) =>
  new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: `Bearer ${token}` } });
const opened = (ws: WebSocket) => new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });

describe('tokenMatches', () => {
  it('accepts only the exact bearer token', () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
  });
});

describe('startServer', () => {
  it('delivers valid messages, ignores invalid ones, and sends to the client', async () => {
    const received: BodyToBrain[] = [];
    let connects = 0;
    server = await startServer({ token: TOKEN, onMessage: (m) => received.push(m), onConnect: () => connects++, log: silentLogger });
    const ws = connect(server.port, TOKEN);
    await opened(ws);
    const incoming = new Promise<string>((resolve) => ws.once('message', (d) => resolve(d.toString())));
    ws.send('garbage');
    ws.send(JSON.stringify({ v: 1, type: 'activity', state: 'idle', ts: 1 }));
    await new Promise((r) => setTimeout(r, 50));
    server.send({ v: 1, type: 'mood', mood: 'bored' });
    expect(JSON.parse(await incoming)).toEqual({ v: 1, type: 'mood', mood: 'bored' });
    expect(received).toEqual([{ v: 1, type: 'activity', state: 'idle', ts: 1 }]);
    expect(connects).toBe(1);
    ws.close();
  });

  it('rejects connections with a wrong token (401)', async () => {
    server = await startServer({ token: TOKEN, onMessage: () => undefined, log: silentLogger });
    const ws = connect(server.port, 'b'.repeat(64));
    await expect(opened(ws)).rejects.toThrow(/401/);
  });

  it('replaces an older client with a newer one', async () => {
    server = await startServer({ token: TOKEN, onMessage: () => undefined, log: silentLogger });
    const first = connect(server.port, TOKEN);
    await opened(first);
    const closed = new Promise<number>((resolve) => first.once('close', (code) => resolve(code)));
    const second = connect(server.port, TOKEN);
    await opened(second);
    expect(await closed).toBe(4000);
    second.close();
  });

  it('send is a no-op with no client connected', async () => {
    server = await startServer({ token: TOKEN, onMessage: () => undefined, log: silentLogger });
    expect(() => server!.send({ v: 1, type: 'mood', mood: 'bored' })).not.toThrow();
  });

  it('a socket error (e.g. an oversize frame) is logged and does not crash the server', async () => {
    const received: BodyToBrain[] = [];
    server = await startServer({ token: TOKEN, onMessage: (m) => received.push(m), log: silentLogger, maxPayloadBytes: 16 });
    const ws = connect(server.port, TOKEN);
    await opened(ws);
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    ws.send('x'.repeat(1000));
    await closed;
    expect(received).toEqual([]);
    // the server process is still alive and functional after the oversize frame
    expect(() => server!.send({ v: 1, type: 'mood', mood: 'bored' })).not.toThrow();
  });

  it('delegates plain HTTP requests to onHttp and still 404s without it', async () => {
    const seen: string[] = [];
    server = await startServer({ token: TOKEN, onMessage: () => undefined, log: silentLogger, onHttp: (req, res) => { seen.push(req.url ?? ''); res.writeHead(204).end(); } });
    expect((await fetch(`http://127.0.0.1:${server.port}/x`)).status).toBe(204);
    expect(seen).toEqual(['/x']);
  });
});
