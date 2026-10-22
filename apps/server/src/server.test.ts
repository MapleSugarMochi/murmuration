import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { defaultProps, type Op } from '@murmuration/doc-model';
import { PROTOCOL_VERSION, encode, type ServerMessage } from '@murmuration/protocol';
import { MemoryStore } from './store.ts';
import {
  connectClient,
  startTestServer,
  waitFor,
  type TestClient,
  type TestServer,
} from './test-utils.ts';

const rect = (id: string, x = 0): Op => ({ t: 'create', id, props: defaultProps('rect', { x }) });

let server: TestServer | null = null;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.close();
  server = null;
});

async function setup() {
  server = await startTestServer();
  const doc = await server.createDoc('Test');
  const join = async (token = doc.editToken) => {
    const c = await connectClient(server!.wsUrl, doc.id, token);
    clients.push(c);
    return c;
  };
  return { server, doc, join };
}

/** Opens a raw socket and returns the messages it receives. */
async function rawSocket(wsUrl: string, hello: object) {
  const ws = new WebSocket(wsUrl);
  const received: ServerMessage[] = [];
  ws.on('message', (d) => received.push(JSON.parse(d.toString()) as ServerMessage));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify(hello));
  return { ws, received };
}

describe('HTTP API', () => {
  it('creates, reads and renames documents', async () => {
    const { server, doc } = await setup();
    const auth = { authorization: `Bearer ${doc.editToken}` };
    const got = await fetch(`${server.url}/api/docs/${doc.id}`, { headers: auth });
    expect(await got.json()).toEqual({ id: doc.id, name: 'Test', role: 'edit' });

    const renamed = await fetch(`${server.url}/api/docs/${doc.id}`, {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(renamed.status).toBe(200);

    const view = await fetch(`${server.url}/api/docs/${doc.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${doc.viewToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nope' }),
    });
    expect(view.status).toBe(403);
    expect((await fetch(`${server.url}/api/docs/${doc.id}`)).status).toBe(401);
    expect((await fetch(`${server.url}/api/docs/missing`, { headers: auth })).status).toBe(404);
  });

  it('serves health and metrics endpoints', async () => {
    const { server } = await setup();
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${server.url}/readyz`)).status).toBe(200);
    expect(await (await fetch(`${server.url}/metrics`)).text()).toContain(
      'murmuration_connections',
    );
  });
});

describe('real-time sync', () => {
  it('shares edits between two editors', async () => {
    const { join } = await setup();
    const a = await join();
    const b = await join();
    await waitFor(() => a.sync.peers.size === 1 && b.sync.peers.size === 1);
    const id = a.sync.newNodeId();
    a.sync.apply([rect(id, 10)]);
    await waitFor(() => b.sync.display.has(id));
    b.sync.apply([{ t: 'set', id, key: 'fill', value: '#ff0000ff' }]);
    a.sync.apply([{ t: 'set', id, key: 'x', value: 99 }]);
    await waitFor(() => a.sync.pendingOpCount === 0 && b.sync.pendingOpCount === 0);
    await waitFor(
      () => a.sync.display.equals(b.sync.display) && a.sync.confirmedSeq === b.sync.confirmedSeq,
    );
    expect(a.sync.display.get(id)).toMatchObject({ x: 99, fill: '#ff0000ff' });
  });

  it('enforces read-only links on the server', async () => {
    const { server, doc, join } = await setup();
    const viewer = await join(doc.viewToken);
    expect(viewer.sync.role).toBe('view');
    const { ws, received } = await rawSocket(server.wsUrl, {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      docId: doc.id,
      token: doc.viewToken,
      name: 'raw',
    });
    await waitFor(() => received.some((m) => m.type === 'welcome'));
    ws.send(encode({ type: 'batch', batchId: 1, ops: [rect('x:1')] }));
    await waitFor(() => received.some((m) => m.type === 'reject'));
    ws.close();
  });

  it('refuses bad tokens and protocol versions', async () => {
    const { server, doc } = await setup();
    const bad = await rawSocket(server.wsUrl, {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      docId: doc.id,
      token: 'wrong',
      name: 'x',
    });
    await waitFor(() => bad.received.some((m) => m.type === 'error' && m.code === 'unauthorized'));
    const old = await rawSocket(server.wsUrl, {
      type: 'hello',
      protocolVersion: 0,
      docId: doc.id,
      token: doc.editToken,
      name: 'x',
    });
    await waitFor(() =>
      old.received.some((m) => m.type === 'error' && m.code === 'protocol_version'),
    );
  });

  it('resends offline edits after reconnecting', async () => {
    const { join } = await setup();
    const a = await join();
    const b = await join();
    const id = a.sync.newNodeId();
    a.sync.apply([rect(id)]);
    await waitFor(() => b.sync.display.has(id));
    a.close();
    await waitFor(() => a.sync.status === 'offline');
    a.sync.apply([{ t: 'set', id, key: 'x', value: 123 }]);
    b.sync.apply([{ t: 'set', id, key: 'y', value: 45 }]);
    await a.reconnect();
    await waitFor(() => b.sync.display.get(id)?.x === 123 && a.sync.display.get(id)?.y === 45);
    expect(a.sync.clientId).toBeTruthy();
  });

  it('closes every connection when links are rotated', async () => {
    const { server, doc, join } = await setup();
    const a = await join();
    const res = await fetch(`${server.url}/api/docs/${doc.id}/rotate-links`, {
      method: 'POST',
      headers: { authorization: `Bearer ${doc.editToken}` },
    });
    const fresh = (await res.json()) as { editToken: string };
    await waitFor(() => a.sync.status === 'offline');
    await expect(connectClient(server.wsUrl, doc.id, doc.editToken)).rejects.toThrow(
      'unauthorized',
    );
    const b = await connectClient(server.wsUrl, doc.id, fresh.editToken);
    clients.push(b);
    expect(b.sync.role).toBe('edit');
  });
});

describe('durability', () => {
  it('restores documents after a graceful restart', async () => {
    const store = new MemoryStore();
    server = await startTestServer(store);
    const doc = await server.createDoc();
    const a = await connectClient(server.wsUrl, doc.id, doc.editToken);
    for (let i = 0; i < 20; i++) a.sync.apply([rect(a.sync.newNodeId(), i)]);
    await waitFor(() => a.sync.pendingOpCount === 0);
    const before = a.sync.display.clone();
    a.close();
    await server.close();

    server = await startTestServer(store);
    const b = await connectClient(server.wsUrl, doc.id, doc.editToken);
    clients.push(b);
    expect(b.sync.display.equals(before)).toBe(true);
  });

  it('resets the room when storage fails, losing nothing that was acked', async () => {
    const store = new MemoryStore();
    server = await startTestServer(store);
    const doc = await server.createDoc();
    const a = await connectClient(server.wsUrl, doc.id, doc.editToken);
    clients.push(a);
    const first = a.sync.newNodeId();
    a.sync.apply([rect(first)]);
    await waitFor(() => a.sync.pendingOpCount === 0);

    store.failNextAppend = true;
    const second = a.sync.newNodeId();
    a.sync.apply([rect(second)]);
    await waitFor(() => a.sync.status === 'offline');
    expect(a.sync.pendingOpCount).toBe(1);

    await a.reconnect();
    await waitFor(() => a.sync.pendingOpCount === 0);
    const fresh = await connectClient(server.wsUrl, doc.id, doc.editToken);
    clients.push(fresh);
    expect(fresh.sync.display.has(first) && fresh.sync.display.has(second)).toBe(true);
  });
});
