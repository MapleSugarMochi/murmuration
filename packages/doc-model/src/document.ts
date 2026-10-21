import {
  ROOT_ID,
  isContainerType,
  isPropKey,
  type NodeId,
  type NodeProps,
  type Op,
} from './types.ts';
import { isValidNodeId, validateNodeProps, validateProp } from './validate.ts';

/**
 * - applied: the op changed the document.
 * - dropped: the op is well-formed but lost a race (its target was deleted,
 *   it would create a cycle, ...). Dropping is deterministic, so every replica
 *   that applies the same ops in the same order drops the same ones.
 * - invalid: the op is malformed and the whole batch must be rejected.
 */
export type ApplyResult =
  | { status: 'applied' }
  | { status: 'dropped'; reason: string }
  | { status: 'invalid'; reason: string };

export type BatchResult =
  | { ok: true; results: ApplyResult[] }
  | { ok: false; reason: string; opIndex: number };

const APPLIED: ApplyResult = { status: 'applied' };
const dropped = (reason: string): ApplyResult => ({ status: 'dropped', reason });
const invalid = (reason: string): ApplyResult => ({ status: 'invalid', reason });

function freezeProps(props: NodeProps): NodeProps {
  return Object.freeze({ ...props, points: Object.freeze([...props.points]) as number[] });
}

function compareSiblings(nodes: Map<NodeId, NodeProps>) {
  return (a: NodeId, b: NodeId): number => {
    const ia = nodes.get(a)!.index;
    const ib = nodes.get(b)!.index;
    if (ia !== ib) return ia < ib ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  };
}

/**
 * A flat table of nodes. The tree is expressed through each node's
 * `parentId` and `index`, so every edit is "set one property of one node".
 * Stored props objects are frozen and replaced on write, which makes
 * `clone()` a cheap shallow copy.
 */
export class Document {
  private readonly nodes: Map<NodeId, NodeProps>;
  private readonly kids: Map<NodeId, Set<NodeId>>;
  private readonly sortedCache: Map<NodeId, readonly NodeId[]>;
  private journal: Array<[NodeId, NodeProps | undefined]> | null = null;
  /** Ids touched by writes, collected for change notification. */
  private touched: Set<NodeId> | null = null;

  constructor(
    nodes?: Map<NodeId, NodeProps>,
    kids?: Map<NodeId, Set<NodeId>>,
    sortedCache?: Map<NodeId, readonly NodeId[]>,
  ) {
    this.nodes = nodes ?? new Map();
    this.kids = kids ?? new Map();
    this.sortedCache = sortedCache ?? new Map();
  }

  /** Builds a document from trusted entries (a snapshot). */
  static fromEntries(entries: Iterable<readonly [NodeId, NodeProps]>): Document {
    const doc = new Document();
    for (const [id, props] of entries) doc.put(id, freezeProps(props));
    return doc;
  }

  get size(): number {
    return this.nodes.size;
  }

  get(id: NodeId): NodeProps | undefined {
    return this.nodes.get(id);
  }

  has(id: NodeId): boolean {
    return this.nodes.has(id);
  }

  ids(): IterableIterator<NodeId> {
    return this.nodes.keys();
  }

  entries(): IterableIterator<[NodeId, NodeProps]> {
    return this.nodes.entries();
  }

  toEntries(): Array<[NodeId, NodeProps]> {
    return [...this.nodes.entries()];
  }

  clone(): Document {
    const kids = new Map<NodeId, Set<NodeId>>();
    for (const [parent, set] of this.kids) kids.set(parent, new Set(set));
    return new Document(new Map(this.nodes), kids, new Map(this.sortedCache));
  }

  /** Children of `parentId`, bottom-most first. */
  childrenOf(parentId: NodeId): readonly NodeId[] {
    const cached = this.sortedCache.get(parentId);
    if (cached) return cached;
    const set = this.kids.get(parentId);
    const sorted = set ? [...set].sort(compareSiblings(this.nodes)) : [];
    this.sortedCache.set(parentId, sorted);
    return sorted;
  }

  /** True when `ancestor` is a strict ancestor of `id`. */
  isAncestor(ancestor: NodeId, id: NodeId): boolean {
    let cur = this.nodes.get(id)?.parentId;
    // The depth bound protects against a corrupted table looping forever.
    for (let depth = 0; cur !== undefined && depth <= this.nodes.size; depth++) {
      if (cur === ancestor) return true;
      if (cur === ROOT_ID) return false;
      cur = this.nodes.get(cur)?.parentId;
    }
    return false;
  }

  /** `id` followed by all of its descendants, parents before children. */
  subtree(id: NodeId): NodeId[] {
    const out: NodeId[] = [];
    const visit = (n: NodeId) => {
      out.push(n);
      for (const c of this.childrenOf(n)) visit(c);
    };
    if (this.nodes.has(id)) visit(id);
    return out;
  }

  /** Applies one op. Invalid ops leave the document untouched. */
  apply(op: Op, touched?: Set<NodeId>): ApplyResult {
    this.touched = touched ?? null;
    try {
      return this.applyInner(op);
    } finally {
      this.touched = null;
    }
  }

  /**
   * Applies ops atomically: if any op is invalid, every earlier op in the
   * batch is rolled back and the document is unchanged.
   */
  applyBatch(ops: readonly Op[], touched?: Set<NodeId>): BatchResult {
    const journal: Array<[NodeId, NodeProps | undefined]> = [];
    const localTouched = new Set<NodeId>();
    this.journal = journal;
    this.touched = localTouched;
    const results: ApplyResult[] = [];
    try {
      for (let i = 0; i < ops.length; i++) {
        const res = this.applyInner(ops[i]!);
        if (res.status === 'invalid') {
          this.journal = null;
          for (let j = journal.length - 1; j >= 0; j--) {
            const [id, prev] = journal[j]!;
            if (prev === undefined) this.remove(id);
            else this.put(id, prev);
          }
          return { ok: false, reason: res.reason, opIndex: i };
        }
        results.push(res);
      }
    } finally {
      this.journal = null;
      this.touched = null;
    }
    if (touched) for (const id of localTouched) touched.add(id);
    return { ok: true, results };
  }

  /** Structural equality, for tests and the convergence simulator. */
  equals(other: Document): boolean {
    if (this.nodes.size !== other.nodes.size) return false;
    for (const [id, a] of this.nodes) {
      const b = other.nodes.get(id);
      if (!b || !propsEqual(a, b)) return false;
    }
    return true;
  }

  /** Throws if a structural invariant is broken. */
  assertInvariants(): void {
    for (const [id, props] of this.nodes) {
      if (props.parentId !== ROOT_ID) {
        const parent = this.nodes.get(props.parentId);
        if (!parent) throw new Error(`node ${id} has missing parent ${props.parentId}`);
        if (!isContainerType(parent.type)) throw new Error(`node ${id} has non-container parent`);
      }
      if (this.isAncestor(id, id)) throw new Error(`cycle through ${id}`);
      let depth = 0;
      let cur: NodeId = props.parentId;
      while (cur !== ROOT_ID) {
        if (++depth > this.nodes.size) throw new Error(`node ${id} does not reach the root`);
        cur = this.nodes.get(cur)!.parentId;
      }
      const err = validateNodeProps(props);
      if (err) throw new Error(`node ${id}: ${err}`);
    }
  }

  private applyInner(op: Op): ApplyResult {
    if (typeof op !== 'object' || op === null) return invalid('op must be an object');
    switch (op.t) {
      case 'create':
        return this.applyCreate(op.id, op.props);
      case 'set':
        return this.applySet(op.id, op.key, op.value);
      case 'delete':
        return this.applyDelete(op.id);
      default:
        return invalid('unknown op type');
    }
  }

  private checkParent(parentId: NodeId, childId: NodeId | null): ApplyResult | null {
    if (parentId === ROOT_ID) return null;
    const parent = this.nodes.get(parentId);
    if (!parent) return dropped('parent does not exist');
    if (!isContainerType(parent.type)) return invalid('parent is not a container');
    if (childId !== null && (parentId === childId || this.isAncestor(childId, parentId))) {
      return dropped('would create a cycle');
    }
    return null;
  }

  private applyCreate(id: NodeId, props: NodeProps): ApplyResult {
    if (!isValidNodeId(id)) return invalid('invalid node id');
    const err = validateNodeProps(props);
    if (err) return invalid(err);
    const parentErr = this.checkParent(props.parentId, null);
    if (parentErr?.status === 'invalid') return parentErr;
    if (this.nodes.has(id)) return dropped('node already exists');
    if (parentErr) return parentErr;
    this.put(id, freezeProps(props));
    return APPLIED;
  }

  private applySet(id: NodeId, key: unknown, value: unknown): ApplyResult {
    if (!isValidNodeId(id)) return invalid('invalid node id');
    if (!isPropKey(key)) return invalid('invalid property key');
    const err = validateProp(key, value);
    if (err) return invalid(err);
    const prev = this.nodes.get(id);
    if (key === 'parentId') {
      const parentErr = this.checkParent(value as string, id);
      if (parentErr?.status === 'invalid') return parentErr;
      if (!prev) return dropped('node does not exist');
      if (parentErr) return parentErr;
    }
    if (!prev) return dropped('node does not exist');
    const next = key === 'points' ? [...(value as number[])] : value;
    this.put(id, Object.freeze({ ...prev, [key]: next }) as NodeProps);
    return APPLIED;
  }

  private applyDelete(id: NodeId): ApplyResult {
    if (!isValidNodeId(id)) return invalid('invalid node id');
    if (!this.nodes.has(id)) return dropped('node does not exist');
    const ids = this.subtree(id);
    for (let i = ids.length - 1; i >= 0; i--) this.remove(ids[i]!);
    return APPLIED;
  }

  private invalidate(parentId: NodeId): void {
    this.sortedCache.delete(parentId);
  }

  private put(id: NodeId, props: NodeProps): void {
    const prev = this.nodes.get(id);
    this.journal?.push([id, prev]);
    this.touched?.add(id);
    if (prev && prev.parentId !== props.parentId) {
      this.detach(id, prev.parentId);
    }
    if (!prev || prev.parentId !== props.parentId) {
      let set = this.kids.get(props.parentId);
      if (!set) this.kids.set(props.parentId, (set = new Set()));
      set.add(id);
      this.invalidate(props.parentId);
    } else if (prev.index !== props.index) {
      this.invalidate(props.parentId);
    }
    this.nodes.set(id, props);
  }

  private remove(id: NodeId): void {
    const prev = this.nodes.get(id);
    if (!prev) return;
    this.journal?.push([id, prev]);
    this.touched?.add(id);
    this.nodes.delete(id);
    this.detach(id, prev.parentId);
  }

  private detach(id: NodeId, parentId: NodeId): void {
    const set = this.kids.get(parentId);
    if (!set) return;
    set.delete(id);
    if (set.size === 0) this.kids.delete(parentId);
    this.invalidate(parentId);
  }
}

export function propsEqual(a: NodeProps, b: NodeProps): boolean {
  for (const key of Object.keys(a) as Array<keyof NodeProps>) {
    const va = a[key];
    const vb = b[key];
    if (Array.isArray(va) && Array.isArray(vb)) {
      if (va.length !== vb.length || va.some((v, i) => v !== vb[i])) return false;
    } else if (va !== vb) {
      return false;
    }
  }
  return true;
}
