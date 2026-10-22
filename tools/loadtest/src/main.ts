import { parseArgs } from 'node:util';
import WebSocket from 'ws';
import { defaultProps } from '@tandem/doc-model';
import { SyncClient } from '@tandem/sync-client';

/**
 * Load test (PF-05 to PF-07). Spawns bot editors on one document; each bot
 * owns a rectangle and moves it `--rate` times per second. Every move
 * carries its send time in the node name, so every other bot can measure
 * end-to-end latency (bot A sends → server → bot B applies).
 *
 *   pnpm loadtest --url http://localhost:8080 --clients 50 --rate 20 --seconds 30
 *
 * Bots run in one process, so for large runs the client side can become the
 * bottleneck; the report prints the bots' own event-loop delay to check.
 */
const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8080' },
    clients: { type: 'string', default: '50' },
    rate: { type: 'string', default: '20' },
    seconds: { type: 'string', default: '30' },
    docs: { type: 'string', default: '1' },
  },
});

const base = values.url.replace(/\/$/, '');
const wsUrl = base.replace(/^http/, 'ws') + '/ws';
const clients = Number(values.clients);
const rate = Number(values.rate);
const seconds = Number(values.seconds);
const docCount = Number(values.docs);

const latencies: number[] = [];
let sent = 0;
let rejected = 0;

async function createDoc(): Promise<{ id: string; editToken: string }> {
  const res = await fetch(`${base}/api/docs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Load test' }),
  });
  if (!res.ok) throw new Error(`create failed: ${res.status}`);
  return (await res.json()) as { id: string; editToken: string };
}

function bot(
  docId: string,
  token: string,
  index: number,
): Promise<{ sync: SyncClient; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const sync = new SyncClient({
      docId,
      token,
      name: `bot ${index}`,
      scheduleFlush: (flush) => setTimeout(flush, 16),
    });
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => sync.connect((raw) => ws.send(raw)));
    ws.on('message', (d) => sync.receive(d.toString()));
    ws.on('close', () => sync.disconnect());
    ws.on('error', reject);
    sync.rejections.on(() => rejected++);
    sync.changes.on((changed, source) => {
      if (source !== 'remote') return;
      const now = Date.now();
      for (const id of changed) {
        const name = sync.display.get(id)?.name;
        if (name?.startsWith('t:')) latencies.push(now - Number(name.slice(2)));
      }
    });
    sync.ready.on(() => resolve({ sync, ws }));
  });
}

/** Reads the server's Prometheus metrics, when served on the main port. */
async function serverMetrics(): Promise<Record<string, number> | null> {
  try {
    const res = await fetch(`${base}/metrics`);
    const text = await res.text();
    if (!res.ok || !text.includes('tandem_')) return null;
    const out: Record<string, number> = {};
    for (const line of text.split('\n')) {
      const m = /^([a-z_]+) ([0-9.e+-]+)$/.exec(line);
      if (m) out[m[1]!] = Number(m[2]);
    }
    return out;
  } catch {
    return null;
  }
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

async function main() {
  const docs = await Promise.all(Array.from({ length: docCount }, createDoc));
  console.log(`docs: ${docCount}, clients: ${clients}, ${rate} moves/s each, ${seconds}s`);
  const bots: Array<{ sync: SyncClient; ws: WebSocket }> = [];
  const connectStart = performance.now();
  // Connect in parallel waves; one at a time is far too slow for thousands.
  for (let i = 0; i < clients; i += 50) {
    const wave = [];
    for (let j = i; j < Math.min(clients, i + 50); j++) {
      const doc = docs[j % docs.length]!;
      wave.push(bot(doc.id, doc.editToken, j));
    }
    bots.push(...(await Promise.all(wave)));
  }
  const connectSeconds = (performance.now() - connectStart) / 1000;
  const ids = bots.map(({ sync }, i) => {
    const id = sync.newNodeId();
    sync.apply([
      {
        t: 'create',
        id,
        props: defaultProps('rect', { x: (i % 20) * 60, y: Math.floor(i / 20) * 60 }),
      },
    ]);
    return id;
  });
  await new Promise((r) => setTimeout(r, 1000));
  latencies.length = 0;

  // Measure the bots' own event-loop lag to spot a client-side bottleneck.
  let maxLag = 0;
  let lastTick = performance.now();
  const lagTimer = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - lastTick - 100);
    lastTick = now;
  }, 100);

  const before = await serverMetrics();
  const started = Date.now();
  const timers = bots.map(({ sync }, i) =>
    setInterval(() => {
      const t = Date.now();
      sync.apply(
        [
          { t: 'set', id: ids[i]!, key: 'x', value: (t % 1000) / 2 },
          { t: 'set', id: ids[i]!, key: 'name', value: `t:${t}` },
        ],
        { undoable: false },
      );
      sent++;
    }, 1000 / rate),
  );
  await new Promise((r) => setTimeout(r, seconds * 1000));
  for (const t of timers) clearInterval(t);
  clearInterval(lagTimer);
  const elapsed = (Date.now() - started) / 1000;
  const during = await serverMetrics();
  await new Promise((r) => setTimeout(r, 1000));

  const pending = bots.reduce((n, b) => n + b.sync.pendingOpCount, 0);
  const report = {
    clients,
    docs: docCount,
    movesPerSecond: Math.round(sent / elapsed),
    deliveries: latencies.length,
    latencyMs: {
      p50: pct(latencies, 50),
      p95: pct(latencies, 95),
      p99: pct(latencies, 99),
      max: pct(latencies, 100),
    },
    rejected,
    pendingAfterRun: pending,
    botEventLoopMaxLagMs: Math.round(maxLag),
    connectSeconds: Math.round(connectSeconds * 10) / 10,
    server:
      during && before
        ? {
            connections: during.tandem_connections,
            committedOpsPerSecond: Math.round(
              ((during.tandem_ops_applied_total ?? 0) - (before.tandem_ops_applied_total ?? 0)) /
                elapsed,
            ),
            residentMemoryMB: Math.round((during.process_resident_memory_bytes ?? 0) / 2 ** 20),
            heapUsedMB: Math.round((during.nodejs_heap_size_used_bytes ?? 0) / 2 ** 20),
            eventLoopLagP99Ms: Math.round((during.nodejs_eventloop_lag_p99_seconds ?? 0) * 1000),
            meanPersistMs:
              Math.round(
                (((during.tandem_persist_seconds_sum ?? 0) -
                  (before.tandem_persist_seconds_sum ?? 0)) /
                  Math.max(
                    1,
                    (during.tandem_persist_seconds_count ?? 0) -
                      (before.tandem_persist_seconds_count ?? 0),
                  )) *
                  10000,
              ) / 10,
          }
        : 'metrics unavailable (METRICS_PORT set?)',
  };
  console.log(JSON.stringify(report, null, 2));
  for (const { ws } of bots) ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
