import { useEffect, useRef, useState } from 'react';
import { Document, defaultProps, keysBetween, type NodeType } from '@tandem/doc-model';
import { Scene, drawScene, type View } from '@tandem/renderer';

export interface BenchResult {
  shapes: number;
  frames: number;
  frameMs: { p50: number; p95: number; p99: number };
  drawMs: { p50: number; p95: number; p99: number };
  hitTestMs: number;
  buildMs: number;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 100) / 100;
};

/** Deterministic PRNG so every run draws the same scene. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Rendering benchmark (PF-01 to PF-03): /bench?n=10000. Builds a local
 * document, pans and zooms for 10 s, and reports frame times plus the cost
 * of a hit test. Results also land on `window.__benchResult` for scripts.
 */
export function BenchPage() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [result, setResult] = useState<BenchResult | null>(null);
  const n = Number(new URLSearchParams(location.search).get('n') ?? 10_000);
  const seconds = Number(new URLSearchParams(location.search).get('s') ?? 10);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const rand = mulberry32(42);
    const t0 = performance.now();
    const keys = keysBetween(null, null, n);
    const types: NodeType[] = ['rect', 'ellipse', 'rect', 'line'];
    const side = Math.ceil(Math.sqrt(n));
    const entries = keys.map((index, i) => {
      const type = types[i % types.length]!;
      const color = `#${Math.floor(rand() * 0xffffff)
        .toString(16)
        .padStart(6, '0')}ff`;
      return [
        `b:${i}`,
        defaultProps(type, {
          index,
          x: (i % side) * 60 + rand() * 10,
          y: Math.floor(i / side) * 60 + rand() * 10,
          width: 20 + rand() * 30,
          height: 20 + rand() * 30,
          rotation: rand() < 0.2 ? Math.floor(rand() * 360) : 0,
          fill: type === 'line' ? null : color,
          stroke: type === 'line' ? color : null,
        }),
      ] as const;
    });
    const doc = Document.fromEntries(entries);
    const scene = new Scene(doc);
    const buildMs = performance.now() - t0;

    // Hit-test cost, averaged over many random probes.
    const extent = side * 60;
    const probes = 20_000;
    const h0 = performance.now();
    for (let i = 0; i < probes; i++)
      scene.hitTest({ x: rand() * extent, y: rand() * extent }, { tolerance: 2 });
    const hitTestMs = (performance.now() - h0) / probes;

    const frameTimes: number[] = [];
    const drawTimes: number[] = [];
    const start = performance.now();
    let last = start;
    let raf = 0;
    const tick = (now: number) => {
      const t = (now - start) / 1000;
      // Zoom between "everything" and close-up while panning in a circle.
      const zoom = (Math.min(width, height) / extent) * (1.2 + 3 * (0.5 + 0.5 * Math.sin(t * 0.8)));
      const cx = extent / 2 + Math.cos(t * 0.6) * extent * 0.3;
      const cy = extent / 2 + Math.sin(t * 0.6) * extent * 0.3;
      const view: View = { x: cx - width / 2 / zoom, y: cy - height / 2 / zoom, zoom };
      const d0 = performance.now();
      drawScene(ctx, doc, scene, view, { dpr, width, height, background: '#f5f5f5' });
      drawTimes.push(performance.now() - d0);
      if (now !== start) frameTimes.push(now - last);
      last = now;
      if (t < seconds) {
        raf = requestAnimationFrame(tick);
      } else {
        const res: BenchResult = {
          shapes: n,
          frames: frameTimes.length,
          frameMs: { p50: pct(frameTimes, 50), p95: pct(frameTimes, 95), p99: pct(frameTimes, 99) },
          drawMs: { p50: pct(drawTimes, 50), p95: pct(drawTimes, 95), p99: pct(drawTimes, 99) },
          hitTestMs: Math.round(hitTestMs * 10000) / 10000,
          buildMs: Math.round(buildMs),
        };
        (window as unknown as { __benchResult?: BenchResult }).__benchResult = res;
        setResult(res);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [n, seconds]);

  return (
    <div className="bench">
      <canvas ref={ref} />
      <pre data-testid="bench-result">
        {result
          ? JSON.stringify(result, null, 2)
          : `Rendering ${n.toLocaleString()} shapes for ${seconds}s…`}
      </pre>
    </div>
  );
}
