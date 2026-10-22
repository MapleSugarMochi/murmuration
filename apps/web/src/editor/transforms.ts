import {
  ROOT_ID,
  keyBetweenJittered,
  normalizeRotation,
  type Document,
  type NodeId,
  type NodeProps,
  type Op,
} from '@murmuration/doc-model';
import {
  IDENTITY,
  apply,
  applyLinear,
  invert,
  isLineLike,
  multiply,
  rotationOf,
  type Mat,
  type Rect,
  type Scene,
  type Vec,
} from '@murmuration/renderer';

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Rounds to 1/100 px so documents don't fill with float noise. */
export const r2 = (v: number) => Math.round(v * 100) / 100;

export function worldOf(scene: Scene, id: NodeId): Mat {
  return id === ROOT_ID ? IDENTITY : (scene.geometry(id)?.world ?? IDENTITY);
}

export function toLocal(scene: Scene, parentId: NodeId, p: Vec): Vec {
  return apply(invert(worldOf(scene, parentId)), p);
}

/** The selection without nodes whose ancestor is also selected. */
export function topLevel(doc: Document, ids: Iterable<NodeId>): NodeId[] {
  const set = new Set(ids);
  return [...set].filter((id) => {
    let cur = doc.get(id)?.parentId;
    while (cur && cur !== ROOT_ID) {
      if (set.has(cur)) return false;
      cur = doc.get(cur)?.parentId;
    }
    return doc.has(id);
  });
}

/** An index above every current child of `parentId`. */
export function topIndex(doc: Document, parentId: NodeId): string {
  const kids = doc.childrenOf(parentId);
  const last = kids.at(-1);
  return keyBetweenJittered(last ? doc.get(last)!.index : null, null);
}

function setIfChanged(
  ops: Op[],
  id: NodeId,
  props: NodeProps,
  key: 'x' | 'y' | 'width' | 'height' | 'rotation',
  value: number,
) {
  if (props[key] !== value) ops.push({ t: 'set', id, key, value });
}

/**
 * Ops that give node `id` the rigid world transform `world` under
 * `parentId`, keeping its size.
 */
export function placeOps(
  doc: Document,
  scene: Scene,
  id: NodeId,
  world: Mat,
  parentId: NodeId,
): Op[] {
  const props = doc.get(id)!;
  const local = multiply(invert(worldOf(scene, parentId)), world);
  const rotation = normalizeRotation(Math.round(rotationOf(local) * 1000) / 1000);
  const center = apply(local, { x: props.width / 2, y: props.height / 2 });
  const ops: Op[] = [];
  if (props.parentId !== parentId) {
    ops.push({ t: 'set', id, key: 'parentId', value: parentId });
    ops.push({ t: 'set', id, key: 'index', value: topIndex(doc, parentId) });
  }
  setIfChanged(ops, id, props, 'x', r2(center.x - props.width / 2));
  setIfChanged(ops, id, props, 'y', r2(center.y - props.height / 2));
  setIfChanged(ops, id, props, 'rotation', rotation);
  return ops;
}

export interface MoveOrigin {
  x: number;
  y: number;
  /** World → parent-local linear map, for converting deltas. */
  toParent: Mat;
}

export function moveOrigins(doc: Document, scene: Scene, ids: NodeId[]): Map<NodeId, MoveOrigin> {
  const out = new Map<NodeId, MoveOrigin>();
  for (const id of ids) {
    const p = doc.get(id)!;
    out.set(id, { x: p.x, y: p.y, toParent: invert(worldOf(scene, p.parentId)) });
  }
  return out;
}

export function moveOps(origins: Map<NodeId, MoveOrigin>, delta: Vec): Op[] {
  const ops: Op[] = [];
  for (const [id, o] of origins) {
    const d = applyLinear(o.toParent, delta);
    ops.push({ t: 'set', id, key: 'x', value: r2(o.x + d.x) });
    ops.push({ t: 'set', id, key: 'y', value: r2(o.y + d.y) });
  }
  return ops;
}

/** Moves nodes by a world-space delta (nudge, align, distribute). */
export function moveByOps(doc: Document, scene: Scene, ids: NodeId[], delta: Vec): Op[] {
  return moveOps(moveOrigins(doc, scene, ids), delta);
}

export interface ResizeStart {
  id: NodeId;
  props: NodeProps;
  world: Mat;
}

interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Moves the box edges named by `handle` to `p` (in box space). */
function dragEdges(
  box: Rect,
  handle: Handle,
  p: Vec,
  keepAspect: boolean,
  fromCenter: boolean,
): Edges {
  let left = box.x;
  let top = box.y;
  let right = box.x + box.width;
  let bottom = box.y + box.height;
  if (handle.includes('w')) left = p.x;
  if (handle.includes('e')) right = p.x;
  if (handle.includes('n')) top = p.y;
  if (handle.includes('s')) bottom = p.y;
  if (fromCenter) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    if (handle.includes('w')) right = 2 * cx - left;
    if (handle.includes('e')) left = 2 * cx - right;
    if (handle.includes('n')) bottom = 2 * cy - top;
    if (handle.includes('s')) top = 2 * cy - bottom;
  }
  if (keepAspect && box.width > 0 && box.height > 0) {
    const sx = (right - left) / box.width;
    const sy = (bottom - top) / box.height;
    const corner = handle.length === 2;
    const s = corner
      ? Math.abs(sx) > Math.abs(sy)
        ? sx
        : sy
      : handle === 'e' || handle === 'w'
        ? sx
        : sy;
    const w = box.width * Math.abs(s) * Math.sign(sx || 1);
    const h = box.height * Math.abs(s) * Math.sign(sy || 1);
    if (fromCenter) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      left = cx - w / 2;
      right = cx + w / 2;
      top = cy - h / 2;
      bottom = cy + h / 2;
    } else {
      if (handle.includes('w')) left = right - w;
      else right = left + w;
      if (handle.includes('n')) top = bottom - h;
      else bottom = top + h;
    }
  }
  return { left, top, right, bottom };
}

function scaledPoints(props: NodeProps, e: Edges, box: Rect, minX: number, minY: number): number[] {
  const sx = box.width === 0 ? 1 : (e.right - e.left) / box.width;
  const sy = box.height === 0 ? 1 : (e.bottom - e.top) / box.height;
  return props.points.map((v, i) =>
    i % 2 === 0 ? r2(e.left + (v - box.x) * sx - minX) : r2(e.top + (v - box.y) * sy - minY),
  );
}

/** Resizes one node in its own (possibly rotated) frame. */
export function resizeSingleOps(
  scene: Scene,
  start: ResizeStart,
  handle: Handle,
  pointer: Vec,
  keepAspect: boolean,
  fromCenter: boolean,
): Op[] {
  const { id, props, world } = start;
  const box = { x: 0, y: 0, width: props.width, height: props.height };
  const p = apply(invert(world), pointer);
  const e = dragEdges(box, handle, p, keepAspect, fromCenter);
  const minX = Math.min(e.left, e.right);
  const minY = Math.min(e.top, e.bottom);
  const w = Math.abs(e.right - e.left);
  const h = Math.abs(e.bottom - e.top);
  const centerWorld = apply(world, { x: minX + w / 2, y: minY + h / 2 });
  const center = toLocal(scene, props.parentId, centerWorld);
  const ops: Op[] = [
    { t: 'set', id, key: 'x', value: r2(center.x - w / 2) },
    { t: 'set', id, key: 'y', value: r2(center.y - h / 2) },
    { t: 'set', id, key: 'width', value: r2(w) },
    { t: 'set', id, key: 'height', value: r2(h) },
  ];
  if (isLineLike(props) && props.points.length > 0) {
    ops.push({ t: 'set', id, key: 'points', value: scaledPoints(props, e, box, minX, minY) });
  }
  return ops;
}

/** Scales several nodes inside their shared world-space bounding box. */
export function resizeMultiOps(
  scene: Scene,
  starts: ResizeStart[],
  box: Rect,
  handle: Handle,
  pointer: Vec,
  keepAspect: boolean,
  fromCenter: boolean,
): Op[] {
  const e = dragEdges(box, handle, pointer, keepAspect, fromCenter);
  const sx = box.width === 0 ? 1 : (e.right - e.left) / box.width;
  const sy = box.height === 0 ? 1 : (e.bottom - e.top) / box.height;
  const ops: Op[] = [];
  for (const { id, props, world } of starts) {
    const c = apply(world, { x: props.width / 2, y: props.height / 2 });
    const nc = { x: e.left + (c.x - box.x) * sx, y: e.top + (c.y - box.y) * sy };
    const w = props.width * Math.abs(sx);
    const h = props.height * Math.abs(sy);
    const center = toLocal(scene, props.parentId, nc);
    ops.push(
      { t: 'set', id, key: 'x', value: r2(center.x - w / 2) },
      { t: 'set', id, key: 'y', value: r2(center.y - h / 2) },
      { t: 'set', id, key: 'width', value: r2(w) },
      { t: 'set', id, key: 'height', value: r2(h) },
    );
    if (isLineLike(props) && props.points.length > 0) {
      // Scale in the node's own box; a negative scale mirrors the points.
      const scaled = props.points.map((v, i) => {
        const s = i % 2 === 0 ? sx : sy;
        const sv = v * Math.abs(s);
        return r2(s < 0 ? (i % 2 === 0 ? w : h) - sv : sv);
      });
      ops.push({ t: 'set', id, key: 'points', value: scaled });
    }
  }
  return ops;
}

/** Rotates nodes by `deg` around world point `pivot`. */
export function rotateOps(scene: Scene, starts: ResizeStart[], pivot: Vec, deg: number): Op[] {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const ops: Op[] = [];
  for (const { id, props, world } of starts) {
    const c = apply(world, { x: props.width / 2, y: props.height / 2 });
    const dx = c.x - pivot.x;
    const dy = c.y - pivot.y;
    const nc = { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
    const center = toLocal(scene, props.parentId, nc);
    ops.push(
      { t: 'set', id, key: 'x', value: r2(center.x - props.width / 2) },
      { t: 'set', id, key: 'y', value: r2(center.y - props.height / 2) },
      {
        t: 'set',
        id,
        key: 'rotation',
        value: normalizeRotation(Math.round((props.rotation + deg) * 1000) / 1000),
      },
    );
  }
  return ops;
}

export type Alignment = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

export function alignOps(doc: Document, scene: Scene, ids: NodeId[], how: Alignment): Op[] {
  const box = scene.boundsOfNodes(ids);
  if (!box) return [];
  const ops: Op[] = [];
  for (const id of ids) {
    const b = scene.geometry(id)!.bounds;
    const delta = { x: 0, y: 0 };
    if (how === 'left') delta.x = box.x - b.x;
    if (how === 'hcenter') delta.x = box.x + box.width / 2 - (b.x + b.width / 2);
    if (how === 'right') delta.x = box.x + box.width - (b.x + b.width);
    if (how === 'top') delta.y = box.y - b.y;
    if (how === 'vcenter') delta.y = box.y + box.height / 2 - (b.y + b.height / 2);
    if (how === 'bottom') delta.y = box.y + box.height - (b.y + b.height);
    if (delta.x !== 0 || delta.y !== 0) ops.push(...moveByOps(doc, scene, [id], delta));
  }
  return ops;
}

/** Equal gaps between nodes along one axis. */
export function distributeOps(doc: Document, scene: Scene, ids: NodeId[], axis: 'x' | 'y'): Op[] {
  if (ids.length < 3) return [];
  const items = ids
    .map((id) => ({ id, b: scene.geometry(id)!.bounds }))
    .sort((a, b) => (axis === 'x' ? a.b.x - b.b.x : a.b.y - b.b.y));
  const size = (r: Rect) => (axis === 'x' ? r.width : r.height);
  const pos = (r: Rect) => (axis === 'x' ? r.x : r.y);
  const first = items[0]!.b;
  const last = items.at(-1)!.b;
  const span = pos(last) + size(last) - pos(first);
  const total = items.reduce((n, it) => n + size(it.b), 0);
  const gap = (span - total) / (items.length - 1);
  const ops: Op[] = [];
  let cursor = pos(first);
  for (const { id, b } of items) {
    const d = cursor - pos(b);
    if (Math.abs(d) > 0.001)
      ops.push(...moveByOps(doc, scene, [id], axis === 'x' ? { x: d, y: 0 } : { x: 0, y: d }));
    cursor += size(b) + gap;
  }
  return ops;
}

/** Nodes in z-order with a one-step move up or down among siblings. */
export function reorderOps(
  doc: Document,
  ids: NodeId[],
  how: 'forward' | 'backward' | 'front' | 'back',
): Op[] {
  const ops: Op[] = [];
  for (const id of ids) {
    const props = doc.get(id);
    if (!props) continue;
    const sibs = doc.childrenOf(props.parentId).filter((s) => s !== id);
    const pos = doc.childrenOf(props.parentId).indexOf(id);
    let at: number;
    if (how === 'front') at = sibs.length;
    else if (how === 'back') at = 0;
    else if (how === 'forward') at = Math.min(sibs.length, pos + 1);
    else at = Math.max(0, pos - 1);
    const before = at > 0 ? doc.get(sibs[at - 1]!)!.index : null;
    const after = at < sibs.length ? doc.get(sibs[at]!)!.index : null;
    if (before !== null && after !== null && before >= after) continue;
    ops.push({ t: 'set', id, key: 'index', value: keyBetweenJittered(before, after) });
  }
  return ops;
}
