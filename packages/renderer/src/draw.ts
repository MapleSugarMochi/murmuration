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

const cssCache = new Map<string, string>();

/** #RRGGBBAA → a canvas colour string. */
export function cssColor(c: string): string {
  let css = cssCache.get(c);
  if (css !== undefined) return css;
  const a = parseInt(c.slice(7, 9), 16) / 255;
  if (a === 1) css = c.slice(0, 7);
  else {
    const r = parseInt(c.slice(1, 3), 16);
    const g = parseInt(c.slice(3, 5), 16);
    const b = parseInt(c.slice(5, 7), 16);
    css = `rgba(${r},${g},${b},${a.toFixed(3)})`;
  }
  if (cssCache.size > 4096) cssCache.clear();
  cssCache.set(c, css);
  return css;
}

/** #RRGGBBAA × opacity → a little-endian RGBA pixel for ImageData. */
function pixelColor(c: string, opacity: number): number {
  const r = parseInt(c.slice(1, 3), 16);
  const g = parseInt(c.slice(3, 5), 16);
  const b = parseInt(c.slice(5, 7), 16);
  const a = Math.round(parseInt(c.slice(7, 9), 16) * opacity);
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Shapes smaller than this many device pixels become a flat box. */
const TINY_PX = 3;
/**
 * Shapes up to this size are rasterised per pixel instead of through the
 * Canvas path pipeline, whose fixed per-shape cost dominates when tens of
 * thousands of small shapes are on screen.
 */
const SMALL_PX = 8;

/**
 * A pixel buffer for shapes too small to need vector drawing. Writing a
 * few pixels into a Uint32Array is far cheaper than a Canvas call, which
 * matters when 100,000 shapes are on screen. The buffer is composited once,
 * after the vector shapes, so a sub-pixel shape can show above a larger
 * shape painted later in the same frame — an accepted level-of-detail
 * approximation.
 */
class PixelLayer {
  private static readonly layers = new WeakMap<object, PixelLayer>();
  private canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
  private image: ImageData | null = null;
  private pixels = new Uint32Array(0);
  private width = 0;
  private height = 0;
  private dirty = false;

  static for(ctx: CanvasRenderingContext2D, width: number, height: number): PixelLayer {
    let layer = PixelLayer.layers.get(ctx);
    if (!layer) PixelLayer.layers.set(ctx, (layer = new PixelLayer()));
    layer.resize(width, height);
    return layer;
  }

  private resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.image = new ImageData(Math.max(1, width), Math.max(1, height));
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(Math.max(1, width), Math.max(1, height))
        : Object.assign(document.createElement('canvas'), { width, height });
  }

  fill(x: number, y: number, w: number, h: number, color: number, clip: DeviceRect | null): void {
    let x0 = Math.floor(x);
    let y0 = Math.floor(y);
    let x1 = Math.max(x0 + 1, Math.ceil(x + w));
    let y1 = Math.max(y0 + 1, Math.ceil(y + h));
    if (clip) {
      x0 = Math.max(x0, Math.floor(clip.x0));
      y0 = Math.max(y0, Math.floor(clip.y0));
      x1 = Math.min(x1, Math.ceil(clip.x1));
      y1 = Math.min(y1, Math.ceil(clip.y1));
    }
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(this.width, x1);
    y1 = Math.min(this.height, y1);
    if (x0 >= x1 || y0 >= y1) return;
    for (let py = y0; py < y1; py++)
      this.pixels.fill(color, py * this.width + x0, py * this.width + x1);
    this.dirty = true;
  }

  /**
   * Rasterises a small shape by testing each pixel centre against its real
   * geometry in local space (one sample per pixel, no antialiasing). `m`
   * maps world to device; `inv` maps world to the node's local space.
   */
  rasterize(
    p: NodeProps,
    inv: Mat,
    s: number,
    ox: number,
    oy: number,
    box: DeviceRect,
    clip: DeviceRect | null,
  ): void {
    let x0 = Math.max(0, Math.floor(box.x0));
    let y0 = Math.max(0, Math.floor(box.y0));
    let x1 = Math.min(this.width, Math.ceil(box.x1));
    let y1 = Math.min(this.height, Math.ceil(box.y1));
    if (clip) {
      x0 = Math.max(x0, Math.floor(clip.x0));
      y0 = Math.max(y0, Math.floor(clip.y0));
      x1 = Math.min(x1, Math.ceil(clip.x1));
      y1 = Math.min(y1, Math.ceil(clip.y1));
    }
    if (x0 >= x1 || y0 >= y1) return;
    const fill = p.fill ? pixelColor(p.fill, p.opacity) : 0;
    const stroke = p.stroke && p.strokeWidth > 0 ? pixelColor(p.stroke, p.opacity) : 0;
    // Keep strokes at least one device pixel wide so outlines never vanish.
    const half = Math.max(p.strokeWidth / 2, 0.5 / s);
    const w = p.width;
    const h = p.height;
    const pts = p.type === 'line' || p.type === 'arrow' || p.type === 'path' ? pointsOf(p) : null;
    const rx = w / 2;
    const ry = h / 2;
    let wrote = false;
    for (let py = y0; py < y1; py++) {
      const wy = (py + 0.5 - oy) / s;
      for (let px = x0; px < x1; px++) {
        const wx = (px + 0.5 - ox) / s;
        const lx = inv.a * wx + inv.c * wy + inv.e;
        const ly = inv.b * wx + inv.d * wy + inv.f;
        let color = 0;
        if (pts) {
          if (stroke) {
            for (let i = 1; i < pts.length; i++) {
              // Inline point-to-segment distance: this runs per pixel.
              const a = pts[i - 1]!;
              const b = pts[i]!;
              const sx = b.x - a.x;
              const sy = b.y - a.y;
              const len2 = sx * sx + sy * sy;
              const t =
                len2 === 0
                  ? 0
                  : Math.max(0, Math.min(1, ((lx - a.x) * sx + (ly - a.y) * sy) / len2));
              if (Math.hypot(lx - (a.x + t * sx), ly - (a.y + t * sy)) <= half) {
                color = stroke;
                break;
              }
            }
          }
        } else if (p.type === 'ellipse') {
          if (rx <= 0 || ry <= 0) continue;
          const dx = (lx - rx) / rx;
          const dy = (ly - ry) / ry;
          const r = Math.sqrt(dx * dx + dy * dy);
          if (stroke && Math.abs(r - 1) * Math.min(rx, ry) <= half) color = stroke;
          else if (fill && r <= 1) color = fill;
        } else {
          const inside = lx >= 0 && ly >= 0 && lx <= w && ly <= h;
          const edge = Math.min(Math.abs(lx), Math.abs(w - lx), Math.abs(ly), Math.abs(h - ly));
          const nearBox = lx >= -half && ly >= -half && lx <= w + half && ly <= h + half;
          if (stroke && nearBox && edge <= half) color = stroke;
          else if (fill && inside) color = fill;
        }
        if (color !== 0) {
          this.pixels[py * this.width + px] = color;
          wrote = true;
        }
      }
    }
    if (wrote) this.dirty = true;
  }

  /** Draws the buffered pixels onto `ctx` and clears the buffer. */
  composite(ctx: CanvasRenderingContext2D): void {
    if (!this.dirty || !this.canvas || !this.image) return;
    const lctx = this.canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!lctx) return;
    lctx.putImageData(this.image, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.canvas, 0, 0);
    this.pixels.fill(0);
    this.dirty = false;
  }
}

interface DeviceRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Canvas state as last set by the fast paths, so each style is only
 * assigned when it actually changes. `null` fields are unknown.
 */
interface PaintState {
  identity: boolean;
  fill: string | null;
  stroke: string | null;
  alpha: number | null;
  lineWidth: number | null;
}

const unknownState = (): PaintState => ({
  identity: false,
  fill: null,
  stroke: null,
  alpha: null,
  lineWidth: null,
});

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
  const vx1 = visible.x + visible.width;
  const vy1 = visible.y + visible.height;
  const s = vm.a;
  const layer = PixelLayer.for(ctx, Math.round(width * dpr), Math.round(height * dpr));
  let state = unknownState();
  // Open clips: the list index where each ends, and its device-space box
  // (used to clip the pixel layer, which the canvas clip does not reach).
  const clipEnds: number[] = [];
  const clipRects: DeviceRect[] = [];

  const list = scene.displayList();
  for (let i = 0; i < list.length; i++) {
    while (clipEnds.length > 0 && clipEnds.at(-1) === i) {
      clipEnds.pop();
      clipRects.pop();
      ctx.restore();
      state = unknownState();
    }
    const { id, props, geom, clipEnd } = list[i]!;
    const b = geom.bounds;
    const onScreen =
      b.x <= vx1 && b.x + b.width >= visible.x && b.y <= vy1 && b.y + b.height >= visible.y;
    if (!onScreen) {
      stats.culled++;
      // A clipped frame off screen hides its whole subtree.
      if (clipEnd >= 0) i = clipEnd - 1;
      continue;
    }
    if (!options.hidden?.has(id)) {
      stats.drawn++;
      const dx = b.x * s + vm.e;
      const dy = b.y * s + vm.f;
      const dw = b.width * s;
      const dh = b.height * s;
      const color = props.fill ?? props.stroke;
      const pixelable = props.type !== 'text' && clipEnd < 0;
      if (pixelable && dw < TINY_PX && dh < TINY_PX) {
        if (color)
          layer.fill(dx, dy, dw, dh, pixelColor(color, props.opacity), clipRects.at(-1) ?? null);
      } else if (pixelable && dw <= SMALL_PX && dh <= SMALL_PX) {
        layer.rasterize(
          props,
          geom.inverse,
          s,
          vm.e,
          vm.f,
          { x0: dx, y0: dy, x1: dx + dw, y1: dy + dh },
          clipRects.at(-1) ?? null,
        );
      } else if (!drawFast(ctx, props, geom.world, s, vm, state)) {
        drawNode(ctx, props, multiply(vm, geom.world), view.zoom);
        state = unknownState();
      }
    }
    if (clipEnd >= 0) {
      ctx.save();
      const m = multiply(vm, geom.world);
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.beginPath();
      roundedRect(ctx, 0, 0, props.width, props.height, props.cornerRadius);
      ctx.clip();
      state = unknownState();
      const outer = clipRects.at(-1);
      const r = {
        x0: b.x * s + vm.e,
        y0: b.y * s + vm.f,
        x1: (b.x + b.width) * s + vm.e,
        y1: (b.y + b.height) * s + vm.f,
      };
      clipRects.push(
        outer
          ? {
              x0: Math.max(r.x0, outer.x0),
              y0: Math.max(r.y0, outer.y0),
              x1: Math.min(r.x1, outer.x1),
              y1: Math.min(r.y1, outer.y1),
            }
          : r,
      );
      clipEnds.push(clipEnd);
    }
  }
  while (clipEnds.length > 0) {
    clipEnds.pop();
    ctx.restore();
  }
  layer.composite(ctx);

  const labels: Array<{ id: NodeId; props: NodeProps }> = [];
  if (options.frameLabels) {
    for (const id of doc.childrenOf(ROOT_ID)) {
      const props = doc.get(id);
      if (props?.type === 'frame' && props.visible) labels.push({ id, props });
    }
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

/**
 * Draws common shapes straight in device coordinates, without a per-shape
 * transform, assigning only the styles that changed. Returns false for
 * anything it does not handle (rotated boxes, text, arrows, rounded
 * corners), which the caller draws with `drawNode`.
 */
function drawFast(
  ctx: CanvasRenderingContext2D,
  p: NodeProps,
  w: Mat,
  s: number,
  vm: Mat,
  state: PaintState,
): boolean {
  const axisAligned = w.b === 0 && w.c === 0;
  const isLine = p.type === 'line' || p.type === 'path';
  if (
    !isLine &&
    !(axisAligned && (p.type === 'rect' || p.type === 'frame' || p.type === 'ellipse'))
  ) {
    return false;
  }
  if ((p.type === 'rect' || p.type === 'frame') && p.cornerRadius * s >= 0.5) return false;
  if (!state.identity) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    state.identity = true;
  }
  if (state.alpha !== p.opacity) {
    ctx.globalAlpha = p.opacity;
    state.alpha = p.opacity;
  }
  const setFill = (c: string) => {
    const css = cssColor(c);
    if (state.fill !== css) {
      ctx.fillStyle = css;
      state.fill = css;
    }
  };
  const setStroke = (c: string, width: number) => {
    const css = cssColor(c);
    if (state.stroke !== css) {
      ctx.strokeStyle = css;
      state.stroke = css;
    }
    if (state.lineWidth !== width) {
      ctx.lineWidth = width;
      state.lineWidth = width;
    }
  };

  if (isLine) {
    if (!p.stroke) return true;
    const pts = pointsOf(p);
    if (pts.length === 0) return true;
    // Map local points to device space by hand: world, then view.
    const ma = w.a * s;
    const mb = w.b * s;
    const mc = w.c * s;
    const md = w.d * s;
    const me = w.e * s + vm.e;
    const mf = w.f * s + vm.f;
    const X = (q: { x: number; y: number }) => ma * q.x + mc * q.y + me;
    const Y = (q: { x: number; y: number }) => mb * q.x + md * q.y + mf;
    setStroke(p.stroke, p.strokeWidth * s);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(X(pts[0]!), Y(pts[0]!));
    if (p.type === 'path' && pts.length > 2) {
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const bq = pts[i + 1]!;
        const mid = { x: (a.x + bq.x) / 2, y: (a.y + bq.y) / 2 };
        ctx.quadraticCurveTo(X(a), Y(a), X(mid), Y(mid));
      }
      ctx.lineTo(X(pts.at(-1)!), Y(pts.at(-1)!));
    } else {
      for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i]!), Y(pts[i]!));
    }
    ctx.stroke();
    return true;
  }

  const x = w.e * s + vm.e;
  const y = w.f * s + vm.f;
  const dw = p.width * s;
  const dh = p.height * s;
  if (p.type === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(x + dw / 2, y + dh / 2, dw / 2, dh / 2, 0, 0, Math.PI * 2);
    if (p.fill) {
      setFill(p.fill);
      ctx.fill();
    }
    if (p.stroke && p.strokeWidth > 0) {
      setStroke(p.stroke, p.strokeWidth * s);
      ctx.stroke();
    }
    return true;
  }
  if (p.fill) {
    setFill(p.fill);
    ctx.fillRect(x, y, dw, dh);
  }
  if (p.stroke && p.strokeWidth > 0) {
    setStroke(p.stroke, p.strokeWidth * s);
    ctx.strokeRect(x, y, dw, dh);
  }
  return true;
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
