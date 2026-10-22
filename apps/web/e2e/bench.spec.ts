import { expect, test } from '@playwright/test';

interface BenchResult {
  frameMs: { p50: number; p95: number; p99: number };
  drawMs: { p50: number; p95: number; p99: number };
  hitTestMs: number;
}

/**
 * Renders 10,000 shapes while panning and zooming (PF-01, PF-03). The
 * numbers are printed and recorded in docs/benchmarks.md from a real
 * machine. CI runners have no GPU and rasterise in software (draw p95 was
 * 37 ms there against 13.7 ms locally), so in CI the bound only catches
 * large regressions.
 */
const DRAW_P95_LIMIT_MS = process.env.CI ? 100 : 33;

test('renders 10k shapes smoothly', async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.goto('/bench?n=10000&s=8');
  // Poll with evaluate: waitForFunction needs eval, which our CSP forbids.
  const read = () =>
    page.evaluate(
      () => (window as unknown as { __benchResult?: BenchResult }).__benchResult ?? null,
    );
  await expect.poll(read, { timeout: 30_000 }).not.toBeNull();
  const result = (await read())!;
  console.log('bench', JSON.stringify(result));
  await info.attach('bench.json', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
  expect(result.drawMs.p95).toBeLessThan(DRAW_P95_LIMIT_MS);
  expect(result.hitTestMs).toBeLessThan(0.5);
});
