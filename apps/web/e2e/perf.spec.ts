import { expect, test, type Page } from '@playwright/test';

/**
 * Performance measurements behind docs/benchmarks.md. Skipped by default:
 *   PERF=1 pnpm e2e perf
 * Results are printed as JSON lines prefixed with "perf".
 */
test.skip(!process.env.PERF, 'set PERF=1 to run performance measurements');
test.describe.configure({ mode: 'serial' });

interface BenchResult {
  shapes: number;
  mode: string;
  frames: number;
  frameMs: { p50: number; p95: number; p99: number };
  drawMs: { p50: number; p95: number; p99: number };
  hitTestMs: number;
  buildMs: number;
}

async function bench(page: Page, n: number, mode: 'mixed' | 'out'): Promise<BenchResult> {
  await page.goto(`/bench?n=${n}&s=8&mode=${mode}`);
  const read = () =>
    page.evaluate(
      () => (window as unknown as { __benchResult?: BenchResult }).__benchResult ?? null,
    );
  await expect.poll(read, { timeout: 60_000 }).not.toBeNull();
  return (await read())!;
}

for (const [n, mode] of [
  [10_000, 'mixed'],
  [10_000, 'out'],
  [100_000, 'mixed'],
  [100_000, 'out'],
] as const) {
  test(`render ${n} shapes (${mode})`, async ({ page }) => {
    test.setTimeout(120_000);
    const r = await bench(page, n, mode);
    console.log('perf', JSON.stringify({ pf: n === 10_000 ? 'PF-01' : 'PF-02', ...r }));
  });
}

test('upload bandwidth while dragging one shape (PF-08)', async ({ page }) => {
  test.setTimeout(60_000);
  const res = await page.request.post('/api/docs', { data: { name: 'PF-08' } });
  const doc = (await res.json()) as { id: string; editToken: string };
  const sent: Array<{ t: number; bytes: number; type: string }> = [];
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      const text = typeof f.payload === 'string' ? f.payload : f.payload.toString();
      const type = /"type":"(\w+)"/.exec(text)?.[1] ?? '?';
      sent.push({ t: Date.now(), bytes: Buffer.byteLength(text), type });
    }),
  );
  await page.goto(`/d/${doc.id}#edit=${doc.editToken}`);
  await expect(page.getByTestId('status')).toContainText('Saved');
  const box = (await page.getByTestId('canvas').boundingBox())!;
  await page.keyboard.press('r');
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 400, box.y + 400, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('status')).toContainText('Saved');

  // Drag in a circle for 5 s, one pointer move per 60 Hz frame.
  await page.mouse.move(box.x + 350, box.y + 350);
  await page.mouse.down();
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < 5000) {
    const a = (i++ / 60) * Math.PI;
    await page.mouse.move(box.x + 350 + Math.cos(a) * 150, box.y + 350 + Math.sin(a) * 150);
    await page.waitForTimeout(4);
  }
  const end = Date.now();
  await page.mouse.up();
  const secs = (end - start) / 1000;
  const during = sent.filter((m) => m.t >= start && m.t <= end);
  const sum = (type?: string) =>
    during.filter((m) => !type || m.type === type).reduce((n, m) => n + m.bytes, 0);
  const result = {
    pf: 'PF-08',
    seconds: Math.round(secs * 10) / 10,
    pointerMoves: i,
    messagesPerSecond: Math.round(during.length / secs),
    totalBytesPerSecond: Math.round(sum() / secs),
    batchBytesPerSecond: Math.round(sum('batch') / secs),
    presenceBytesPerSecond: Math.round(sum('presence') / secs),
  };
  console.log('perf', JSON.stringify(result));
});

test('open a 10,000-shape document (PF-04)', async ({ browser, page }) => {
  test.setTimeout(180_000);
  const res = await page.request.post('/api/docs', { data: { name: 'PF-04' } });
  const doc = (await res.json()) as { id: string; editToken: string };
  const url = `/d/${doc.id}#edit=${doc.editToken}`;

  // Fill the document through the real editor, in chunks the server accepts.
  await page.goto(url);
  await expect(page.getByTestId('status')).toContainText('Saved');
  await page.evaluate(async () => {
    type Sync = {
      newNodeId(): string;
      apply(ops: unknown[], o?: object): void;
      flush(): void;
      pendingOpCount: number;
    };
    const editor = (window as unknown as { __tandem: { sync: Sync } }).__tandem;
    const side = 100;
    for (let chunk = 0; chunk < 20; chunk++) {
      const ops = [];
      for (let i = 0; i < 500; i++) {
        const k = chunk * 500 + i;
        ops.push({
          t: 'create',
          id: editor.sync.newNodeId(),
          props: {
            type: k % 3 === 0 ? 'ellipse' : 'rect',
            parentId: 'root',
            // Equal indexes are legal: siblings tie-break by id.
            index: 'a0',
            x: (k % side) * 60,
            y: Math.floor(k / side) * 60,
            width: 40,
            height: 40,
            rotation: 0,
            fill: '#4f8ff7ff',
            stroke: null,
            strokeWidth: 1,
            opacity: 1,
            cornerRadius: 0,
            points: [],
            text: '',
            fontSize: 16,
            name: `Shape ${k}`,
            visible: true,
            locked: false,
            clipContent: false,
          },
        });
      }
      editor.sync.apply(ops, { undoable: false });
      editor.sync.flush();
      // Stay under the server's per-connection op rate limit.
      await new Promise((r) => setTimeout(r, 1800));
    }
    while (editor.sync.pendingOpCount > 0) await new Promise((r) => setTimeout(r, 50));
  });

  // A second person opens it cold.
  const context = await browser.newContext();
  const fresh = await context.newPage();
  const t0 = Date.now();
  await fresh.goto(url);
  await expect(fresh.getByTestId('status')).toContainText('Saved', { timeout: 30_000 });
  await fresh.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  const openMs = Date.now() - t0;
  const count = await fresh.evaluate(
    () => (window as unknown as { __tandem: { doc: { size: number } } }).__tandem.doc.size,
  );
  expect(count).toBe(10_000);
  console.log('perf', JSON.stringify({ pf: 'PF-04', shapes: count, openMs }));
});
