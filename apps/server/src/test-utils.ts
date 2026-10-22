import WebSocket from 'ws';
import { SyncClient } from '@murmuration/sync-client';
import { buildApp, type App } from './app.ts';
import { loadConfig } from './config.ts';
import { MemoryStore, type Store } from './store.ts';

export interface TestServer {
  app: App;
  store: Store;
  url: string;
  wsUrl: string;
  createDoc(name?: string): Promise<{ id: string; editToken: string; viewToken: string }>;
  close(): Promise<void>;
}

export async function startTestServer(store: Store = new MemoryStore()): Promise<TestServer> {
  const config = {
    ...loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test-secret-test-secret-test-secret' }),
    port: 0,
    host: '127.0.0.1',
    logLevel: 'silent',
    commitDelayMs: 1,
  };
  const app = await buildApp(config, store);
  await app.fastify.listen({ host: config.host, port: 0 });
  const addr = app.fastify.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    app,
    store,
    url,
    wsUrl: `ws://127.0.0.1:${addr.port}/ws`,
    async createDoc(name) {
      const res = await fetch(`${url}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(name ? { name } : {}),
      });
      return (await res.json()) as { id: string; editToken: string; viewToken: string };
    },
    close: () => app.shutdown(),
  };
}

export interface TestClient {
  sync: SyncClient;
  ws: WebSocket;
  /** Reopens the socket (the SyncClient keeps its state). */
  reconnect(): Promise<void>;
  close(): void;
}

/** A SyncClient over a real WebSocket, flushing on every microtask. */
export async function connectClient(
  wsUrl: string,
  docId: string,
  token: string,
  name = 'tester',
): Promise<TestClient> {
  const sync = new SyncClient({
    docId,
    token,
    name,
    scheduleFlush: (flush) => queueMicrotask(flush),
  });
  const client: TestClient = {
    sync,
    ws: null!,
    async reconnect() {
      const ws = new WebSocket(wsUrl);
      client.ws = ws;
      ws.on('open', () => sync.connect((raw) => ws.send(raw)));
      ws.on('message', (data) => sync.receive(data.toString()));
      ws.on('close', () => {
        if (client.ws === ws) sync.disconnect();
      });
      await new Promise<void>((resolve, reject) => {
        const offReady = sync.statusChanges.on((s) => {
          if (s === 'connected') {
            offReady();
            resolve();
          }
        });
        const offErr = sync.errors.on((e) => {
          offErr();
          reject(new Error(e.code));
        });
      });
    },
    close() {
      client.ws.close();
    },
  };
  await client.reconnect();
  return client;
}

export async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}
