import { ROOT_ID, type Document, type NodeId, type NodeProps } from '@tandem/doc-model';
import { apply, intersects, multiply, type Mat, type Rect } from './geometry.ts';
import { pointsOf, type Scene } from './scene.ts';

export const FONT_FAMILY = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
export const LINE_HEIGHT = 1.25;

export interface View {
  /** World coordinate at the canvas's top-left corner. */
  x: number;
  y: number;
  zoom: number;
}

export interface DrawOptions {
  /** Device pixel ratio of the canvas backing store. */
  dpr: number;
  /** Canvas size in CSS pixels. */
  width: number;
  height: number;
  /** Nodes not to draw (e.g. text under the live editor). */
  hidden?: ReadonlySet<NodeId>;
  /** Draw names above top-level frames. */
  frameLabels?: boolean;
  background?: string;
}

export interface DrawStats {
  drawn: number;
  culled: number;
}

/** #RRGGBBAA → a canvas colour string. */
export function cssColor(c: string): string {
  const a = parseInt(c.slice(7, 9), 16) / 255;
  if (a === 1) return c.slice(0, 7);
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

export function viewMatrix(view: View, dpr: number): Mat {
  const s = view.zoom * dpr;
  return { a: s, b: 0, c: 0, d: s, e: -view.x * s, f: -view.y * s };
}

export function visibleWorldRect(view: View, width: number, height: number): Rect {
  return { x: view.x, y: view.y, width: width / view.zoom, height: height / view.zoom };
}

/** Draws the document content. Overlays are drawn separately. */
export function drawScene(
  ctx: CanvasRenderingContext2D,
  doc: Document,
  scene: Scene,
  view: View,
  options: DrawOptions,
): DrawStats {
  const { dpr, width, height } = options;
  const stats: DrawStats = { drawn: 0, culled: 0 };
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, width * dpr, height * dpr);
  } else {
    ctx.clearRect(0, 0, width * dpr, height * dpr);
  }
  const vm = viewMatrix(view, dpr);
  const visible = visibleWorldRect(view, width, height);
  const labels: Array<{ id: NodeId; props: NodeProps }> = [];

  const visit = (id: NodeId) => {
    const props = doc.get(id);
    const g = scene.geometry(id);
    if (!props || !g || !props.visible) return;
    const onScreen = intersects(g.bounds, visible);
    if (props.type === 'frame' && props.clipContent && !onScreen) {
      stats.culled++;
      return;
    }
    if (onScreen && !options.hidden?.has(id)) {
      drawNode(ctx, props, multiply(vm, g.world), view.zoom);
      stats.drawn++;
    } else {
      stats.culled++;
    }
    const kids = doc.childrenOf(id);
    if (kids.length === 0) return;
    if (props.type === 'frame' && props.clipContent) {
      ctx.save();
      const m = multiply(vm, g.world);
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.beginPath();
      roundedRect(ctx, 0, 0, props.width, props.height, props.cornerRadius);
      ctx.clip();
      for (const c of kids) visit(c);
      ctx.restore();
    } else {
      for (const c of kids) visit(c);
    }
  };

  for (const id of doc.childrenOf(ROOT_ID)) {
    visit(id);
    const props = doc.get(id);
    if (options.frameLabels && props?.type === 'frame' && props.visible) labels.push({ id, props });
  }

  if (labels.length > 0) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `11px ${FONT_FAMILY}`;
    ctx.fillStyle = '#6b6b6b';
    ctx.textBaseline = 'bottom';
    for (const { id, props } of labels) {
      const g = scene.geometry(id);
      if (!g || !intersects(g.bounds, { ...visible, y: visible.y - 30 / view.zoom })) continue;
      const tl = apply(g.world, { x: 0, y: 0 });
      ctx.fillText(props.name, (tl.x - view.x) * view.zoom, (tl.y - view.y) * view.zoom - 4);
    }
  }
  return stats;
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  if (radius <= 0) ctx.rect(x, y, w, h);
  else ctx.roundRect(x, y, w, h, radius);
}

/** Draws one node with `m` mapping its local space to device pixels. */
export function drawNode(ctx: CanvasRenderingContext2D, p: NodeProps, m: Mat, zoom: number): void {
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.globalAlpha = p.opacity;

  // Level of detail: shapes under ~2 screen pixels become a flat box.
  if (Math.max(p.width, p.height) * zoom < 2 && p.type !== 'text') {
    const color = p.fill ?? p.stroke;
    if (color) {
      ctx.fillStyle = cssColor(color);
      ctx.fillRect(0, 0, Math.max(p.width, 1 / zoom), Math.max(p.height, 1 / zoom));
    }
    ctx.globalAlpha = 1;
    return;
  }

  switch (p.type) {
    case 'rect':
    case 'frame':
      ctx.beginPath();
      roundedRect(ctx, 0, 0, p.width, p.height, p.cornerRadius);
      fillAndStroke(ctx, p);
      break;
    case 'ellipse':
      ctx.beginPath();
      ctx.ellipse(p.width / 2, p.height / 2, p.width / 2, p.height / 2, 0, 0, Math.PI * 2);
      fillAndStroke(ctx, p);
      break;
    case 'line':
    case 'arrow':
    case 'path':
      drawPolyline(ctx, p);
      break;
    case 'text':
      drawText(ctx, p);
      break;
  }
  ctx.globalAlpha = 1;
}

function fillAndStroke(ctx: CanvasRenderingContext2D, p: NodeProps): void {
  if (p.fill) {
    ctx.fillStyle = cssColor(p.fill);
    ctx.fill();
  }
  if (p.stroke && p.strokeWidth > 0) {
    ctx.strokeStyle = cssColor(p.stroke);
    ctx.lineWidth = p.strokeWidth;
    ctx.stroke();
  }
}

function drawPolyline(ctx: CanvasRenderingContext2D, p: NodeProps): void {
  const pts = pointsOf(p);
  if (pts.length === 0 || !p.stroke) return;
  ctx.strokeStyle = cssColor(p.stroke);
  ctx.lineWidth = p.strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  if (p.type === 'path' && pts.length > 2) {
    // Smooth freehand strokes through segment midpoints.
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i]!.x + pts[i + 1]!.x) / 2;
      const my = (pts[i]!.y + pts[i + 1]!.y) / 2;
      ctx.quadraticCurveTo(pts[i]!.x, pts[i]!.y, mx, my);
    }
    ctx.lineTo(pts.at(-1)!.x, pts.at(-1)!.y);
  } else {
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  }
  ctx.stroke();

  if (p.type === 'arrow' && pts.length >= 2) {
    const tip = pts.at(-1)!;
    const from = pts.at(-2)!;
    const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
    const size = Math.max(8, p.strokeWidth * 4);
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(
      tip.x - size * Math.cos(angle - Math.PI / 7),
      tip.y - size * Math.sin(angle - Math.PI / 7),
    );
    ctx.lineTo(
      tip.x - size * Math.cos(angle + Math.PI / 7),
      tip.y - size * Math.sin(angle + Math.PI / 7),
    );
    ctx.closePath();
    ctx.fillStyle = cssColor(p.stroke);
    ctx.fill();
  }
}

function drawText(ctx: CanvasRenderingContext2D, p: NodeProps): void {
  if (!p.fill || p.text.length === 0) return;
  ctx.font = `${p.fontSize}px ${FONT_FAMILY}`;
  ctx.fillStyle = cssColor(p.fill);
  ctx.textBaseline = 'top';
  const lh = p.fontSize * LINE_HEIGHT;
  const pad = (lh - p.fontSize) / 2;
  p.text.split('\n').forEach((line, i) => ctx.fillText(line, 0, i * lh + pad));
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** Box size for a text node's content. */
export function measureText(text: string, fontSize: number): { width: number; height: number } {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  const lines = text.split('\n');
  let width = 0;
  if (measureCtx) {
    measureCtx.font = `${fontSize}px ${FONT_FAMILY}`;
    for (const line of lines) width = Math.max(width, measureCtx.measureText(line).width);
  } else {
    width = Math.max(...lines.map((l) => l.length)) * fontSize * 0.6;
  }
  return {
    width: Math.ceil(Math.max(width, 1)),
    height: Math.ceil(lines.length * fontSize * LINE_HEIGHT),
  };
}

/** Renders `ids` (with their subtrees) into a new canvas, for PNG export. */
export function renderToCanvas(
  doc: Document,
  scene: Scene,
  ids: readonly NodeId[],
  pixelRatio: number,
  background: string | null,
): HTMLCanvasElement | null {
  const bounds = scene.boundsOfNodes(ids);
  if (!bounds || bounds.width === 0 || bounds.height === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(bounds.width * pixelRatio);
  canvas.height = Math.ceil(bounds.height * pixelRatio);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const vm = viewMatrix({ x: bounds.x, y: bounds.y, zoom: 1 }, pixelRatio);
  const visit = (id: NodeId) => {
    const p = doc.get(id);
    const g = scene.geometry(id);
    if (!p || !g || !p.visible) return;
    drawNode(ctx, p, multiply(vm, g.world), pixelRatio);
    for (const c of doc.childrenOf(id)) visit(c);
  };
  for (const id of scene.sortByOrder(ids)) visit(id);
  return canvas;
}
