import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { defaultProps } from '@murmuration/doc-model';
import { Room } from '@murmuration/room';
import { PgStore } from './pg-store.ts';
import { connectClient, startTestServer, waitFor } from './test-utils.ts';

const url = process.env.TEST_DATABASE_URL;

// Runs in CI against a Postgres service; skipped when no database is given.
describe.skipIf(!url)('PgStore', () => {
  let store: PgStore;

  beforeAll(async () => {
    store = new PgStore(url!);
    await store.migrate();
    // Migrating twice is a no-op.
    expect(await store.migrate()).toEqual([]);
  });

  afterAll(async () => {
    await store?.close();
  });

  const newDoc = async () => {
    const id = randomBytes(6).toString('hex');
    const now = new Date();
    await store.createDoc({
      id,
      name: 'pg',
      editTokenHash: 'a'.repeat(64),
      viewTokenHash: 'b'.repeat(64),
      createdAt: now,
      updatedAt: now,
    });
    return id;
  };

  it('round-trips documents, batches and snapshots', async () => {
    const id = await newDoc();
    expect((await store.getDoc(id))?.name).toBe('pg');
    await store.renameDoc(id, 'renamed');
    expect((await store.getDoc(id))?.name).toBe('renamed');

    const room = new Room();
    const results = [1, 2, 3].map((n) =>
      room.submit('c', n, [{ t: 'create', id: `c:${n}`, props: defaultProps('rect', { x: n }) }]),
    );
    const batches = results.map((r) => (r.kind === 'applied' ? r.batch : null!));
    await store.appendBatches(id, batches.slice(0, 2));
    await store.saveSnapshot(id, Room.restore(null, batches.slice(0, 2)).snapshot());
    await store.appendBatches(id, batches.slice(2));

    const loaded = await store.loadRoom(id);
    expect(loaded.snapshot?.seq).toBe(2);
    expect(loaded.batches.map((b) => b.seq)).toEqual([3]);
    expect(Room.restore(loaded.snapshot, loaded.batches).doc.equals(room.doc)).toBe(true);
  });

  it('refuses to reuse a seq', async () => {
    const id = await newDoc();
    const batch = { seq: 1, clientId: 'c', batchId: 1, ops: [{ t: 'delete' as const, id: 'x:1' }] };
    await store.appendBatches(id, [batch]);
    await expect(store.appendBatches(id, [batch])).rejects.toThrow();
  });

  it('survives a server restart end to end', async () => {
    const server = await startTestServer(store);
    const doc = await server.createDoc();
    const a = await connectClient(server.wsUrl, doc.id, doc.editToken);
    for (let i = 0; i < 10; i++)
      a.sync.apply([
        { t: 'create', id: a.sync.newNodeId(), props: defaultProps('ellipse', { x: i }) },
      ]);
    await waitFor(() => a.sync.pendingOpCount === 0);
    const before = a.sync.display.clone();
    a.close();
    // Shut down without closing the shared pool.
    await server.app.rooms.shutdown();
    await server.app.fastify.close();

    const again = await startTestServer(store);
    const b = await connectClient(again.wsUrl, doc.id, doc.editToken);
    expect(b.sync.display.equals(before)).toBe(true);
    b.close();
    await again.app.rooms.shutdown();
    await again.app.fastify.close();
  });
});
