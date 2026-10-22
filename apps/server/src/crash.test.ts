import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultProps } from '@tandem/doc-model';
import { connectClient, waitFor, type TestClient } from './test-utils.ts';

const url = process.env.TEST_DATABASE_URL;
const serverDir = fileURLToPath(new URL('..', import.meta.url));
let port = 18_200;

/** Runs the real server as a separate process, so it can be hard-killed. */
async function startServer(p: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(p),
      HOST: '127.0.0.1',
      DATABASE_URL: url,
      SESSION_SECRET: 'crash-test-secret-crash-test-secret-0000',
      LOG_LEVEL: 'warn',
      COMMIT_DELAY_MS: '5',
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${p}/readyz`)).ok) return child;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const clients: TestClient[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const c of children.splice(0)) c.kill('SIGKILL');
});

// SV-04: kill -9 the server mid-load; nothing that was acked may be lost,
// and clients must recover everything else by resending.
describe.skipIf(!url)('crash recovery (SV-04)', () => {
  it('loses no acknowledged edit when the process is killed mid-write', async () => {
    const p = port++;
    const first = await startServer(p);
    children.push(first);
    const res = await fetch(`http://127.0.0.1:${p}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const doc = (await res.json()) as { id: string; editToken: string };
    const wsUrl = `ws://127.0.0.1:${p}/ws`;
    const writer = await connectClient(wsUrl, doc.id, doc.editToken, 'writer');
    clients.push(writer);

    // Write steadily: one shape every 5 ms (under the 300 ops/s limit).
    let created = 0;
    let writing = true;
    const pump = (async () => {
      while (writing) {
        writer.sync.apply([
          { t: 'create', id: writer.sync.newNodeId(), props: defaultProps('rect', { x: created }) },
        ]);
        created++;
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    await waitFor(() => writer.sync.confirmed.size >= 200, 10_000);
    // The acknowledged set at the instant of the crash.
    first.kill('SIGKILL');
    const acked = new Set(writer.sync.confirmed.ids());
    await waitFor(() => writer.sync.status === 'offline', 5_000);
    // Keep editing while the server is down.
    await new Promise((r) => setTimeout(r, 200));
    writing = false;
    await pump;
    expect(writer.sync.pendingOpCount).toBeGreaterThan(0);

    const second = await startServer(p);
    children.push(second);

    // A fresh client sees every acknowledged shape before the writer returns.
    const reader = await connectClient(wsUrl, doc.id, doc.editToken, 'reader');
    clients.push(reader);
    const missing = [...acked].filter((id) => !reader.sync.display.has(id));
    expect(missing).toEqual([]);

    // The writer reconnects and resends; nothing is lost or duplicated.
    await writer.reconnect();
    await waitFor(() => writer.sync.pendingOpCount === 0, 10_000);
    await waitFor(() => reader.sync.display.size === created, 10_000);
    expect(writer.sync.display.equals(reader.sync.display)).toBe(true);
    expect(reader.sync.display.size).toBe(created);
    console.log(`crash test: ${acked.size} acked before kill, ${created} created in total`);
  }, 60_000);
});
