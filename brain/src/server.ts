import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import type { Logger } from './logger.js';
import { encodeBrainMessage, parseBodyMessage, type BodyToBrain, type BrainToBody } from './protocol.js';

export interface BrainServer {
  port: number;
  send(msg: BrainToBody): void;
  close(): Promise<void>;
}

const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

export function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function startServer(opts: {
  token: string;
  port?: number;
  onMessage: (m: BodyToBrain) => void;
  onConnect?: () => void;
  log: Logger;
}): Promise<BrainServer> {
  const http = createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  let client: WebSocket | undefined;

  http.on('upgrade', (req, socket, head) => {
    if (!tokenMatches(req.headers.authorization, opts.token)) {
      opts.log.warn('ws_rejected', { reason: 'bad token' });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      client?.close(4000, 'replaced by a newer connection');
      client = ws;
      opts.log.info('ws_connected');
      opts.onConnect?.();
      ws.on('message', (data) => {
        const msg = parseBodyMessage(data.toString());
        if (msg) opts.onMessage(msg);
        else opts.log.warn('ws_invalid_message');
      });
      ws.on('close', () => {
        if (client === ws) client = undefined;
      });
    });
  });

  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  return {
    port,
    send(msg) {
      if (client?.readyState === WebSocket.OPEN) client.send(encodeBrainMessage(msg));
    },
    close: () =>
      new Promise<void>((resolve) => {
        client?.terminate();
        wss.close();
        http.close(() => resolve());
      }),
  };
}
