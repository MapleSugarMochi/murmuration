import { containsRect, intersects, type Rect } from './geometry.ts';

const MAX_ITEMS = 8;
const MAX_DEPTH = 16;

class QuadNode<T> {
  items = new Map<T, Rect>();
  children: QuadNode<T>[] | null = null;

  constructor(
    readonly bounds: Rect,
    readonly depth: number,
  ) {}

  /** The child that fully contains `r`, if any. */
  childFor(r: Rect): QuadNode<T> | null {
    if (!this.children) return null;
    for (const c of this.children) if (containsRect(c.bounds, r)) return c;
    return null;
  }

  split(): void {
    const { x, y, width, height } = this.bounds;
    const w = width / 2;
    const h = height / 2;
    const d = this.depth + 1;
    this.children = [
      new QuadNode<T>({ x, y, width: w, height: h }, d),
      new QuadNode<T>({ x: x + w, y, width: w, height: h }, d),
      new QuadNode<T>({ x, y: y + h, width: w, height: h }, d),
      new QuadNode<T>({ x: x + w, y: y + h, width: w, height: h }, d),
    ];
  }
}

/**
 * Dynamic quadtree for axis-aligned boxes. Each item lives in the deepest
 * node that fully contains it, so straddling items stay high in the tree.
 * The root grows to cover items placed outside it, which suits an
 * unbounded canvas.
 */
export class QuadTree<T> {
  private root: QuadNode<T>;
  private readonly where = new Map<T, QuadNode<T>>();

  constructor(initial: Rect = { x: -4096, y: -4096, width: 8192, height: 8192 }) {
    this.root = new QuadNode<T>(initial, 0);
  }

  get size(): number {
    return this.where.size;
  }

  has(item: T): boolean {
    return this.where.has(item);
  }

  insert(item: T, r: Rect): void {
    this.remove(item);
    while (!containsRect(this.root.bounds, r)) this.grow(r);
    let node = this.root;
    for (;;) {
      if (!node.children && node.items.size >= MAX_ITEMS && node.depth < MAX_DEPTH) {
        node.split();
        // Push down existing items that now fit a child.
        for (const [it, ir] of [...node.items]) {
          const child = node.childFor(ir);
          if (child) {
            node.items.delete(it);
            child.items.set(it, ir);
            this.where.set(it, child);
          }
        }
      }
      const child = node.childFor(r);
      if (!child) break;
      node = child;
    }
    node.items.set(item, r);
    this.where.set(item, node);
  }

  remove(item: T): void {
    const node = this.where.get(item);
    if (!node) return;
    node.items.delete(item);
    this.where.delete(item);
  }

  clear(): void {
    this.root = new QuadNode<T>(this.root.bounds, 0);
    this.where.clear();
  }

  /** Items whose box intersects `r`. */
  query(r: Rect, out: T[] = []): T[] {
    const stack = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (!intersects(node.bounds, r)) continue;
      for (const [item, ir] of node.items) if (intersects(ir, r)) out.push(item);
      if (node.children) stack.push(...node.children);
    }
    return out;
  }

  private grow(toward: Rect): void {
    const b = this.root.bounds;
    const left = toward.x < b.x;
    const up = toward.y < b.y;
    const bigger: Rect = {
      x: left ? b.x - b.width : b.x,
      y: up ? b.y - b.height : b.y,
      width: b.width * 2,
      height: b.height * 2,
    };
    const old = this.root;
    const root = new QuadNode<T>(bigger, 0);
    root.split();
    // Re-home the old root as one quadrant; depths shift but stay bounded
    // by MAX_DEPTH checks on insert.
    const idx = (left ? 1 : 0) + (up ? 2 : 0);
    const slot = root.children![idx]!;
    slot.items = old.items;
    slot.children = old.children;
    for (const [it] of old.items) this.where.set(it, slot);
    this.root = root;
  }
}
