import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  LIMITS,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ErrorCode,
  type ServerMessage,
} from '@murmuration/protocol';
import { CLOSE, type RoomConnection } from '@murmuration/room';
import { roleForToken } from './auth.ts';
import type { Metrics } from './metrics.ts';
import { KeyedLimiter, TokenBucket } from './rate-limit.ts';
import type { RoomHost, RoomManager } from './rooms.ts';
import type { Store } from './store.ts';

export interface WsOptions {
  store: Store;
  rooms: RoomManager;
  metrics: Metrics;
  log: FastifyBaseLogger;
  allowedOrigins: string[];
  maxConnectionsPerIp: number;
  joinsPerSecondPerIp: number;
}

const HELLO_TIMEOUT_MS = 10_000;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** JSON for messages broadcast to many sockets is encoded once. */
const encoded = new WeakMap<object, string>();
function encodeOnce(msg: ServerMessage): string {
  let raw = encoded.get(msg);
  if (raw === undefined) {
    raw = JSON.stringify(msg);
    encoded.set(msg, raw);
  }
  return raw;
}

/** Adapts a WebSocket to the RoomServer's connection interface. */
class SocketConnection implements RoomConnection {
  constructor(
    private readonly ws: WebSocket,
    private readonly metrics: Metrics,
  ) {}

  send(msg: ServerMessage): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    // A client that cannot keep up must not grow server memory without
    // bound; it will reconnect and catch up from the log.
    if (this.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.metrics.backpressureDisconnects.inc();
      this.ws.terminate();
      return;
    }
    this.ws.send(encodeOnce(msg));
  }

  close(code: number, reason: string): void {
    this.ws.close(code, reason.slice(0, 120));
  }
}

export function attachWebSockets(options: WsOptions) {
  const { store, rooms, metrics, log, allowedOrigins, maxConnectionsPerIp, joinsPerSecondPerIp } =
    options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.messageBytes });
  const perIp = new Map<string, number>();
  const helloLimiter = new KeyedLimiter(joinsPerSecondPerIp, joinsPerSecondPerIp * 4);

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (allowedOrigins.length > 0 && (!origin || !allowedOrigins.includes(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const ip = req.socket.remoteAddress ?? 'unknown';
    if ((perIp.get(ip) ?? 0) >= maxConnectionsPerIp) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip));
  }

  function onConnection(ws: WebSocket, ip: string): void {
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    metrics.connections.inc();
    const conn = new SocketConnection(ws, metrics);
    const opsBucket = new TokenBucket(300, 600);
    const bytesBucket = new TokenBucket(1024 * 1024, 2 * 1024 * 1024);
    const presenceBucket = new TokenBucket(30, 60);
    let host: RoomHost | null = null;
    let joining = false;

    const fail = (code: ErrorCode, message: string, closeCode: number = CLOSE.policy) => {
      conn.send({ type: 'error', code, message, fatal: true });
      ws.close(closeCode, message);
    };

    const helloTimer = setTimeout(() => {
      if (!host) fail('bad_message', 'expected hello');
    }, HELLO_TIMEOUT_MS);

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return fail('bad_message', 'binary frames are not supported');
      const raw = data.toString();
      if (!bytesBucket.take(raw.length)) {
        metrics.rateLimited.inc({ kind: 'bytes' });
        return fail('rate_limited', 'rate limit exceeded');
      }
      const parsed = parseClientMessage(raw);
      if (!parsed.ok) return fail('bad_message', parsed.error);
      const msg = parsed.message;

      if (!host) {
        if (msg.type !== 'hello' || joining) return fail('bad_message', 'expected hello');
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          return fail('protocol_version', `server speaks protocol ${PROTOCOL_VERSION}`);
        }
        if (!helloLimiter.take(ip)) return fail('rate_limited', 'too many connection attempts');
        joining = true;
        try {
          const doc = await store.getDoc(msg.docId);
          if (!doc) return fail('not_found', 'document not found');
          const role = roleForToken(doc, msg.token);
          if (!role) return fail('unauthorized', 'invalid or expired link');
          if (ws.readyState !== ws.OPEN) return;
          host = await rooms.acquire(doc.id, doc.name);
          clearTimeout(helloTimer);
          if (ws.readyState !== ws.OPEN) {
            rooms.released(host);
            return;
          }
          host.server.join(conn, msg, role);
        } catch (err) {
          log.error({ err }, 'join failed');
          fail('internal', 'could not open document', CLOSE.internal);
        }
        return;
      }

      // Silently dropping a batch would desync the client, so exceeding a
      // limit closes the socket; the client reconnects and resends.
      if (msg.type === 'batch' && !opsBucket.take(msg.ops.length)) {
        metrics.rateLimited.inc({ kind: 'ops' });
        return fail('rate_limited', 'rate limit exceeded');
      }
      if (msg.type === 'presence' && !presenceBucket.take()) {
        metrics.rateLimited.inc({ kind: 'presence' });
        return; // presence is lossy by design
      }
      host.server.message(conn, msg);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      perIp.set(ip, (perIp.get(ip) ?? 1) - 1);
      if (perIp.get(ip)! <= 0) perIp.delete(ip);
      metrics.connections.dec();
      if (host) {
        host.server.leave(conn);
        rooms.released(host);
      }
    });

    ws.on('error', (err) => log.debug({ err }, 'socket error'));
  }

  return {
    handleUpgrade,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}
