import { ROOT_ID, type Document, type NodeId, type NodeProps } from '@murmuration/doc-model';
import {
  IDENTITY,
  apply,
  boundsOf,
  containsPoint,
  corners,
  distanceToSegment,
  expand,
  invert,
  localMatrix,
  multiply,
  unionRects,
  type Mat,
  type Rect,
  type Vec,
} from './geometry.ts';
import { QuadTree } from './quadtree.ts';

export interface NodeGeometry {
  /** Node-local → world. */
  world: Mat;
  /** World → node-local. */
  inverse: Mat;
  /** World-space AABB, including half the stroke. */
  bounds: Rect;
}

/** Pairs of local points for line-like nodes. */
export function pointsOf(p: NodeProps): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i + 1 < p.points.length; i += 2)
    pts.push({ x: p.points[i]!, y: p.points[i + 1]! });
  if (pts.length < 2 && (p.type === 'line' || p.type === 'arrow')) {
    return [
      { x: 0, y: 0 },
      { x: p.width, y: p.height },
    ];
  }
  return pts;
}

export function isLineLike(p: NodeProps): boolean {
  return p.type === 'line' || p.type === 'arrow' || p.type === 'path';
}

export interface HitOptions {
  /** Hit slop in world units. */
  tolerance: number;
  includeLocked?: boolean;
  /** Ids (and their descendants) to ignore, e.g. the nodes being dragged. */
  exclude?: ReadonlySet<NodeId>;
}

export interface DisplayEntry {
  id: NodeId;
  props: NodeProps;
  geom: NodeGeometry;
  /**
   * For a clipping frame with children: the list index just past its
   * subtree, where the clip ends. Otherwise -1.
   */
  clipEnd: number;
}

/**
 * Derived, render-oriented view of a Document: world transforms, world
 * bounds, paint order and a quadtree for hit-testing. Updated incrementally
 * from change sets; only structural changes recompute paint order.
 */
export class Scene {
  private doc: Document;
  private readonly geoms = new Map<NodeId, NodeGeometry>();
  private readonly seen = new Map<NodeId, NodeProps>();
  private readonly tree = new QuadTree<NodeId>();
  private order = new Map<NodeId, number>();
  private orderDirty = true;
  private display: { version: number; list: DisplayEntry[] } | null = null;
  /** Bumped on every update, so views can cache per version. */
  version = 0;

  constructor(doc: Document) {
    this.doc = doc;
    this.rebuild(doc);
  }

  get document(): Document {
    return this.doc;
  }

  rebuild(doc: Document): void {
    this.doc = doc;
    this.geoms.clear();
    this.seen.clear();
    this.tree.clear();
    const visit = (id: NodeId, parent: Mat) => {
      const world = this.computeNode(id, parent);
      for (const c of doc.childrenOf(id)) visit(c, world);
    };
    for (const id of doc.childrenOf(ROOT_ID)) visit(id, IDENTITY);
    this.orderDirty = true;
    this.version++;
  }

  /** Applies a change set from the sync client. */
  update(doc: Document, changed: Iterable<NodeId>): void {
    this.doc = doc;
    const roots = new Set<NodeId>();
    for (const id of changed) {
      const prev = this.seen.get(id);
      const next = doc.get(id);
      if (!next) {
        if (prev) this.forget(id);
        this.orderDirty = true;
        continue;
      }
      if (!prev || prev.parentId !== next.parentId || prev.index !== next.index)
        this.orderDirty = true;
      roots.add(id);
    }
    // Recompute each changed subtree once, from its own parent's transform.
    for (const id of roots) {
      if (this.hasChangedAncestor(id, roots)) continue;
      const parent = doc.get(id)!.parentId;
      const parentWorld =
        parent === ROOT_ID ? IDENTITY : (this.geoms.get(parent)?.world ?? IDENTITY);
      const visit = (n: NodeId, pw: Mat) => {
        const world = this.computeNode(n, pw);
        for (const c of doc.childrenOf(n)) visit(c, world);
      };
      visit(id, parentWorld);
    }
    this.version++;
  }

  geometry(id: NodeId): NodeGeometry | undefined {
    return this.geoms.get(id);
  }

  /**
   * Visible nodes in paint order, flattened for the renderer and rebuilt
   * only when the document changes, so panning and zooming never walk the
   * tree. A clipping frame with children records where its subtree ends.
   */
  displayList(): readonly DisplayEntry[] {
    if (this.display?.version === this.version) return this.display.list;
    const list: DisplayEntry[] = [];
    const visit = (id: NodeId) => {
      const props = this.doc.get(id);
      const geom = this.geoms.get(id);
      if (!props || !geom || !props.visible) return;
      const kids = this.doc.childrenOf(id);
      const entry: DisplayEntry = { id, props, geom, clipEnd: -1 };
      list.push(entry);
      for (const c of kids) visit(c);
      if (props.type === 'frame' && props.clipContent && kids.length > 0)
        entry.clipEnd = list.length;
    };
    for (const id of this.doc.childrenOf(ROOT_ID)) visit(id);
    this.display = { version: this.version, list };
    return list;
  }

  /** Paint order: higher draws later (on top). */
  orderOf(id: NodeId): number {
    if (this.orderDirty) this.computeOrder();
    return this.order.get(id) ?? -1;
  }

  /** Ids sorted bottom to top. */
  sortByOrder(ids: Iterable<NodeId>): NodeId[] {
    return [...ids].sort((a, b) => this.orderOf(a) - this.orderOf(b));
  }

  boundsOfNodes(ids: Iterable<NodeId>): Rect | null {
    const rects: Rect[] = [];
    for (const id of ids) {
      const g = this.geoms.get(id);
      if (g) rects.push(g.bounds);
    }
    return unionRects(rects);
  }

  queryRect(r: Rect): NodeId[] {
    return this.tree.query(r);
  }

  /** True when the node and all its ancestors are visible. */
  isShown(id: NodeId): boolean {
    let cur: NodeId | undefined = id;
    while (cur && cur !== ROOT_ID) {
      const p = this.doc.get(cur);
      if (!p || !p.visible) return false;
      cur = p.parentId;
    }
    return true;
  }

  isLocked(id: NodeId): boolean {
    let cur: NodeId | undefined = id;
    while (cur && cur !== ROOT_ID) {
      const p = this.doc.get(cur);
      if (!p) return false;
      if (p.locked) return true;
      cur = p.parentId;
    }
    return false;
  }

  /** Topmost node under `p`, honouring visibility and frame clipping. */
  hitTest(p: Vec, options: HitOptions): NodeId | null {
    const probe = expand({ x: p.x, y: p.y, width: 0, height: 0 }, options.tolerance);
    const candidates = this.sortByOrder(this.tree.query(probe)).reverse();
    for (const id of candidates) {
      if (options.exclude && this.isExcluded(id, options.exclude)) continue;
      if (!this.isShown(id)) continue;
      if (!options.includeLocked && this.isLocked(id)) continue;
      if (!this.insideClipAncestors(id, p)) continue;
      if (this.hitsNode(id, p, options.tolerance)) return id;
    }
    return null;
  }

  /** Deepest frame containing `p`, ignoring `exclude` and their subtrees. */
  frameAt(p: Vec, exclude?: ReadonlySet<NodeId>): NodeId {
    const candidates = this.sortByOrder(
      this.tree.query({ x: p.x, y: p.y, width: 0, height: 0 }),
    ).reverse();
    for (const id of candidates) {
      const props = this.doc.get(id);
      if (!props || props.type !== 'frame') continue;
      if (exclude && this.isExcluded(id, exclude)) continue;
      if (!this.isShown(id) || !this.insideClipAncestors(id, p)) continue;
      const local = apply(this.geoms.get(id)!.inverse, p);
      if (local.x >= 0 && local.y >= 0 && local.x <= props.width && local.y <= props.height)
        return id;
    }
    return ROOT_ID;
  }

  /** Precise hit test in the node's local space. */
  hitsNode(id: NodeId, p: Vec, tolerance: number): boolean {
    const props = this.doc.get(id);
    const g = this.geoms.get(id);
    if (!props || !g) return false;
    const l = apply(g.inverse, p);
    const { width: w, height: h } = props;
    const tol = tolerance + (props.stroke ? props.strokeWidth / 2 : 0);
    switch (props.type) {
      case 'line':
      case 'arrow':
      case 'path': {
        const pts = pointsOf(props);
        if (pts.length === 1) return Math.hypot(l.x - pts[0]!.x, l.y - pts[0]!.y) <= tol;
        for (let i = 1; i < pts.length; i++) {
          if (distanceToSegment(l, pts[i - 1]!, pts[i]!) <= tol) return true;
        }
        return false;
      }
      case 'ellipse': {
        const rx = w / 2 + tol;
        const ry = h / 2 + tol;
        if (rx <= 0 || ry <= 0) return false;
        const dx = (l.x - w / 2) / rx;
        const dy = (l.y - h / 2) / ry;
        const inside = dx * dx + dy * dy <= 1;
        if (!inside || props.fill) return inside;
        // Unfilled: only the outline is hittable.
        const irx = Math.max(0, w / 2 - tol);
        const iry = Math.max(0, h / 2 - tol);
        if (irx === 0 || iry === 0) return true;
        const ix = (l.x - w / 2) / irx;
        const iy = (l.y - h / 2) / iry;
        return ix * ix + iy * iy >= 1;
      }
      default: {
        const outer = l.x >= -tol && l.y >= -tol && l.x <= w + tol && l.y <= h + tol;
        if (!outer || props.fill || props.type === 'text' || props.type === 'frame') return outer;
        return !(l.x > tol && l.y > tol && l.x < w - tol && l.y < h - tol);
      }
    }
  }

  private isExcluded(id: NodeId, exclude: ReadonlySet<NodeId>): boolean {
    let cur: NodeId | undefined = id;
    while (cur && cur !== ROOT_ID) {
      if (exclude.has(cur)) return true;
      cur = this.doc.get(cur)?.parentId;
    }
    return false;
  }

  private insideClipAncestors(id: NodeId, p: Vec): boolean {
    let cur = this.doc.get(id)?.parentId;
    while (cur && cur !== ROOT_ID) {
      const props = this.doc.get(cur);
      const g = this.geoms.get(cur);
      if (!props || !g) return false;
      if (props.clipContent) {
        const l = apply(g.inverse, p);
        if (!containsPoint({ x: 0, y: 0, width: props.width, height: props.height }, l))
          return false;
      }
      cur = props.parentId;
    }
    return true;
  }

  private hasChangedAncestor(id: NodeId, set: Set<NodeId>): boolean {
    let cur = this.doc.get(id)?.parentId;
    while (cur && cur !== ROOT_ID) {
      if (set.has(cur)) return true;
      cur = this.doc.get(cur)?.parentId;
    }
    return false;
  }

  private computeNode(id: NodeId, parentWorld: Mat): Mat {
    const props = this.doc.get(id)!;
    const world = multiply(parentWorld, localMatrix(props));
    const pts = isLineLike(props)
      ? pointsOf(props).map((pt) => apply(world, pt))
      : corners(world, props.width, props.height);
    const pad = props.stroke
      ? props.strokeWidth / 2 + (props.type === 'arrow' ? props.strokeWidth * 3 : 0)
      : 0;
    const bounds = expand(boundsOf(pts), pad);
    this.geoms.set(id, { world, inverse: invert(world), bounds });
    this.seen.set(id, props);
    this.tree.insert(id, bounds);
    return world;
  }

  private forget(id: NodeId): void {
    this.geoms.delete(id);
    this.seen.delete(id);
    this.tree.remove(id);
  }

  private computeOrder(): void {
    const order = new Map<NodeId, number>();
    let n = 0;
    const visit = (id: NodeId) => {
      order.set(id, n++);
      for (const c of this.doc.childrenOf(id)) visit(c);
    };
    for (const id of this.doc.childrenOf(ROOT_ID)) visit(id);
    this.order = order;
    this.orderDirty = false;
  }
}
