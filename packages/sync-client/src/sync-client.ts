import { Document, inverseOf, type NodeId, type Op } from '@murmuration/doc-model';
import {
  EMPTY_PRESENCE,
  LIMITS,
  PROTOCOL_VERSION,
  encode,
  parseServerMessage,
  type ClientMessage,
  type ErrorMessage,
  type OpsMessage,
  type PeerInfo,
  type PresenceState,
  type Role,
  type ServerMessage,
  type WelcomeMessage,
} from '@murmuration/protocol';

export type ConnectionStatus = 'connecting' | 'connected' | 'offline';
export type ChangeSource = 'local' | 'remote';

export interface SyncClientOptions {
  docId: string;
  token: string;
  name: string;
  /**
   * Called when local ops are waiting to be sent. The caller should invoke
   * `flush()` soon (the web app uses the next animation frame). When
   * omitted, the caller is responsible for calling `flush()` itself.
   */
  scheduleFlush?: (flush: () => void) => void;
  /** Soft cap on bytes per batch; batches are split to stay under it. */
  maxBatchBytes?: number;
}

interface PendingBatch {
  batchId: number;
  ops: Op[];
  /** Sealed batches no longer accept ops and keep their batchId forever. */
  sealed: boolean;
  sent: boolean;
}

type Listener<T extends unknown[]> = (...args: T) => void;

class Emitter<T extends unknown[]> {
  private readonly listeners = new Set<Listener<T>>();
  on(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(...args: T): void {
    for (const fn of this.listeners) fn(...args);
  }
}

/** Keys whose effect depends on other nodes, so their sets never coalesce. */
const ORDER_SENSITIVE_KEYS = new Set(['parentId']);

/**
 * Client half of the sync protocol.
 *
 * It keeps two documents: `confirmed`, which only advances on server
 * results, and `display`, which is `confirmed` with every pending local
 * batch replayed on top. Local edits apply to `display` at once; when the
 * server acks a batch it moves into `confirmed`. Because the server applies
 * the same ops with the same deterministic rules, `display` equals
 * `confirmed` once nothing is pending.
 */
export class SyncClient {
  readonly options: SyncClientOptions;
  confirmed = new Document();
  display = new Document();
  confirmedSeq = 0;
  clientId: string | null = null;
  role: Role = 'view';
  name: string;
  color = '#888888';
  docName = '';
  status: ConnectionStatus = 'offline';
  readonly peers = new Map<string, PeerInfo>();

  /** `author` is the clientId behind a remote change, when known. */
  readonly changes = new Emitter<[changed: Set<NodeId>, source: ChangeSource, author?: string]>();
  readonly statusChanges = new Emitter<[status: ConnectionStatus]>();
  readonly peerChanges = new Emitter<[]>();
  readonly rejections = new Emitter<[batchId: number, reason: string]>();
  readonly errors = new Emitter<[error: ErrorMessage]>();
  readonly ready = new Emitter<[]>();
  /** The number of unconfirmed ops may have changed (ack, reject, edit). */
  readonly pendingChanges = new Emitter<[]>();
  readonly docRenamed = new Emitter<[name: string]>();
  /** A local op was invalid and skipped — always an editor bug. */
  readonly invalidLocalOps = new Emitter<[op: Op, reason: string]>();

  private send: ((raw: string) => void) | null = null;
  private resumeSig: string | null = null;
  private welcomed = false;
  private pending: PendingBatch[] = [];
  private nextBatchId = 1;
  private nodeCounter = 0;
  private flushScheduled = false;
  /** Ids touched by pending ops; candidates for change on rebuild. */
  private pendingTouched = new Set<NodeId>();
  /** Open batch coalescing index: "id\0key" → position in the open batch. */
  private coalesce = new Map<string, number>();

  private undoStack: Op[][] = [];
  private redoStack: Op[][] = [];
  private tx: Op[][] | null = null;
  private txSeenSets: Set<string> | null = null;
  private txTarget: 'undo' | 'redo' = 'undo';
  private replaying = false;

  constructor(options: SyncClientOptions) {
    this.options = options;
    this.name = options.name;
  }

  // ------------------------------------------------------------- connection

  /** Call when the transport opens. Sends `hello` and waits for `welcome`. */
  connect(send: (raw: string) => void): void {
    this.send = send;
    this.welcomed = false;
    this.setStatus('connecting');
    const hello: ClientMessage = {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      docId: this.options.docId,
      token: this.options.token,
      name: this.name,
      ...(this.clientId && this.resumeSig
        ? { resume: { clientId: this.clientId, sig: this.resumeSig }, lastSeq: this.confirmedSeq }
        : {}),
    };
    send(encode(hello));
  }

  /** Call when the transport closes. Pending batches will be resent. */
  disconnect(): void {
    this.send = null;
    this.welcomed = false;
    for (const b of this.pending) b.sent = false;
    if (this.peers.size > 0) {
      this.peers.clear();
      this.peerChanges.emit();
    }
    this.setStatus('offline');
  }

  get isReady(): boolean {
    return this.clientId !== null;
  }

  get canEdit(): boolean {
    return this.role === 'edit';
  }

  /** Ops not yet confirmed by the server. */
  get pendingOpCount(): number {
    let n = 0;
    for (const b of this.pending) n += b.ops.length;
    return n;
  }

  receive(raw: string): void {
    const parsed = parseServerMessage(raw);
    if (!parsed.ok) return;
    this.handle(parsed.message);
  }

  handle(msg: ServerMessage): void {
    switch (msg.type) {
      case 'welcome':
        return this.onWelcome(msg);
      case 'ops':
        return this.onOps(msg);
      case 'ack':
        return this.onAck(msg.batchId, msg.seq);
      case 'reject':
        return this.onReject(msg.batchId, msg.reason);
      case 'presence': {
        const peer = this.peers.get(msg.clientId);
        if (peer) {
          peer.presence = msg.presence;
          this.peerChanges.emit();
        }
        return;
      }
      case 'peer-join':
        this.peers.set(msg.peer.clientId, msg.peer);
        this.peerChanges.emit();
        return;
      case 'peer-leave':
        this.peers.delete(msg.clientId);
        this.peerChanges.emit();
        return;
      case 'doc-renamed':
        this.docName = msg.name;
        this.docRenamed.emit(msg.name);
        return;
      case 'error':
        this.errors.emit(msg);
        return;
      case 'pong':
        return;
    }
  }

  // ------------------------------------------------------------- local edits

  /** A fresh node id that no other client can generate. */
  newNodeId(): NodeId {
    if (!this.clientId) throw new Error('not connected yet');
    return `${this.clientId}:${++this.nodeCounter}`;
  }

  /**
   * Applies local ops immediately and queues them for the server. Outside a
   * transaction, each call is one undo step. Ops that are invalid against
   * the current document are skipped (and reported) rather than sent, since
   * one invalid op would make the server reject the whole batch.
   */
  apply(ops: readonly Op[], options: { undoable?: boolean } = {}): void {
    if (!this.canEdit || ops.length === 0) return;
    const undoable = options.undoable ?? true;
    // A fresh edit invalidates the redo history; undo/redo themselves don't.
    if (undoable && !this.replaying) this.redoStack = [];
    const ownTx = undoable && this.tx === null;
    if (ownTx) this.beginTransaction();
    const touched = new Set<NodeId>();
    for (const op of ops) {
      const inverse = undoable ? this.inverseFor(op) : null;
      const res = this.display.apply(op, touched);
      if (res.status === 'invalid') {
        this.invalidLocalOps.emit(op, res.reason);
        continue;
      }
      if (inverse && this.tx) this.tx.push(inverse);
      this.enqueue(op);
    }
    for (const id of touched) this.pendingTouched.add(id);
    if (ownTx) this.commitTransaction();
    if (touched.size > 0) this.changes.emit(touched, 'local');
  }

  /** Groups subsequent `apply` calls into one undo step (e.g. a drag). */
  beginTransaction(): void {
    if (this.tx) return;
    this.tx = [];
    this.txSeenSets = new Set();
  }

  /**
   * Ends the current transaction. With `discard`, the step is not recorded
   * for undo (e.g. a text node created and then left empty); its ops are
   * still sent.
   */
  commitTransaction(options: { discard?: boolean } = {}): void {
    const tx = this.tx;
    this.tx = null;
    this.txSeenSets = null;
    if (!tx || tx.length === 0 || options.discard) return;
    const step = tx.reverse().flat();
    if (this.txTarget === 'undo') {
      this.undoStack.push(step);
      if (this.undoStack.length > 500) this.undoStack.shift();
    } else {
      this.redoStack.push(step);
    }
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get inTransaction(): boolean {
    return this.tx !== null;
  }

  undo(): boolean {
    return this.replayStep(this.undoStack, 'redo');
  }

  redo(): boolean {
    return this.replayStep(this.redoStack, 'undo');
  }

  setPresence(presence: Partial<PresenceState>): void {
    if (!this.welcomed || !this.send) return;
    this.send(encode({ type: 'presence', ...presence }));
  }

  ping(): void {
    if (this.send) this.send(encode({ type: 'ping', t: Date.now() }));
  }

  /** Seals the open batch and sends everything unsent. */
  flush(): void {
    this.flushScheduled = false;
    const open = this.pending.at(-1);
    if (open && !open.sealed) {
      this.pending.pop();
      this.coalesce.clear();
      for (const part of this.split(open.ops)) {
        this.pending.push({ batchId: this.nextBatchId++, ops: part, sealed: true, sent: false });
      }
    }
    if (!this.welcomed || !this.send) return;
    for (const b of this.pending) {
      if (b.sent) continue;
      b.sent = true;
      this.send(encode({ type: 'batch', batchId: b.batchId, ops: b.ops }));
    }
  }

  // ------------------------------------------------------------- internals

  private inverseFor(op: Op): Op[] | null {
    if (op.t === 'set' && this.txSeenSets) {
      // Within one step only the value before the step matters.
      const key = `${op.id}\0${op.key}`;
      if (this.txSeenSets.has(key)) return null;
      this.txSeenSets.add(key);
    }
    return inverseOf(this.display, op);
  }

  /** Applies an undo/redo step; its inverse lands on the `target` stack. */
  private replayStep(stack: Op[][], target: 'undo' | 'redo'): boolean {
    if (!this.canEdit || this.tx) return false;
    const step = stack.pop();
    if (!step) return false;
    this.replaying = true;
    this.txTarget = target;
    try {
      this.beginTransaction();
      this.apply(step);
      this.commitTransaction();
    } finally {
      this.replaying = false;
      this.txTarget = 'undo';
    }
    return true;
  }

  private enqueue(op: Op): void {
    let open = this.pending.at(-1);
    if (!open || open.sealed) {
      open = { batchId: 0, ops: [], sealed: false, sent: false };
      this.pending.push(open);
      this.coalesce.clear();
    }
    if (op.t === 'set' && !ORDER_SENSITIVE_KEYS.has(op.key)) {
      const key = `${op.id}\0${op.key}`;
      const at = this.coalesce.get(key);
      if (at !== undefined) {
        open.ops[at] = op;
      } else {
        this.coalesce.set(key, open.ops.length);
        open.ops.push(op);
      }
    } else {
      if (op.t !== 'set') {
        // A create/delete changes whether later sets apply, so earlier sets
        // of this node must stay where they are.
        for (const k of [...this.coalesce.keys()]) {
          if (k.startsWith(`${op.id}\0`)) this.coalesce.delete(k);
        }
      }
      open.ops.push(op);
    }
    if (this.options.scheduleFlush && !this.flushScheduled) {
      this.flushScheduled = true;
      this.options.scheduleFlush(() => this.flush());
    }
  }

  private split(ops: Op[]): Op[][] {
    const maxBytes = this.options.maxBatchBytes ?? LIMITS.messageBytes * 0.75;
    const parts: Op[][] = [];
    let cur: Op[] = [];
    let bytes = 0;
    for (const op of ops) {
      const size = JSON.stringify(op).length;
      if (cur.length > 0 && (cur.length >= LIMITS.opsPerBatch || bytes + size > maxBytes)) {
        parts.push(cur);
        cur = [];
        bytes = 0;
      }
      cur.push(op);
      bytes += size;
    }
    if (cur.length > 0) parts.push(cur);
    return parts;
  }

  private onWelcome(msg: WelcomeMessage): void {
    const firstWelcome = this.clientId === null;
    if (this.clientId !== msg.clientId) this.nodeCounter = 0;
    this.clientId = msg.clientId;
    this.resumeSig = msg.resumeSig;
    this.role = msg.role;
    this.name = msg.name;
    this.color = msg.color;
    this.docName = msg.docName;

    const touched = new Set<NodeId>();
    if (msg.snapshot) {
      for (const id of this.confirmed.ids()) touched.add(id);
      this.confirmed = Document.fromEntries(msg.snapshot);
      for (const id of this.confirmed.ids()) touched.add(id);
      this.confirmedSeq = msg.seq;
    } else {
      for (const batch of msg.ops ?? []) this.applyConfirmed(batch, touched);
    }
    // Every batch up to ackedThrough has an outcome the snapshot or catch-up
    // already reflects (applied) or that is final (rejected).
    this.pending = this.pending.filter((b) => !b.sealed || b.batchId > msg.ackedThrough);
    if (this.nextBatchId <= msg.ackedThrough) this.nextBatchId = msg.ackedThrough + 1;
    if (this.role !== 'edit') this.pending = [];

    this.peers.clear();
    for (const peer of msg.peers) this.peers.set(peer.clientId, peer);
    this.peerChanges.emit();

    this.rebuildDisplay(touched);
    this.welcomed = true;
    this.setStatus('connected');
    if (firstWelcome) this.ready.emit();
    this.flush();
  }

  /** Applies a server batch to `confirmed`, consuming it if it is ours. */
  private applyConfirmed(batch: OpsMessage, touched: Set<NodeId>): void {
    if (batch.seq <= this.confirmedSeq) return;
    const ours =
      batch.clientId === this.clientId &&
      this.pending.some((b) => b.sealed && b.batchId === batch.batchId);
    if (ours) {
      // Our own batch whose ack was lost: treat it as the ack.
      this.onAck(batch.batchId, batch.seq);
      return;
    }
    this.confirmed.applyBatch(batch.ops, touched);
    this.confirmedSeq = batch.seq;
  }

  private onOps(msg: OpsMessage): void {
    if (msg.seq <= this.confirmedSeq) return;
    const touched = new Set<NodeId>();
    if (this.pending.length === 0) {
      this.confirmed.applyBatch(msg.ops, touched);
      this.display.applyBatch(msg.ops);
      this.confirmedSeq = msg.seq;
      if (touched.size > 0) this.changes.emit(touched, 'remote', msg.clientId);
      return;
    }
    this.applyConfirmed(msg, touched);
    this.rebuildDisplay(touched, msg.clientId);
  }

  private onAck(batchId: number, seq: number): void {
    const i = this.pending.findIndex((b) => b.sealed && b.batchId === batchId);
    if (i === -1) return;
    const [batch] = this.pending.splice(i, 1);
    this.confirmed.applyBatch(batch!.ops);
    this.confirmedSeq = Math.max(this.confirmedSeq, seq);
    // Acks arrive in order, so `display` already equals confirmed + rest.
    if (i !== 0) this.rebuildDisplay(new Set());
    if (this.pending.length === 0) this.pendingTouched.clear();
    this.pendingChanges.emit();
  }

  private onReject(batchId: number, reason: string): void {
    const i = this.pending.findIndex((b) => b.sealed && b.batchId === batchId);
    if (i === -1) return;
    this.pending.splice(i, 1);
    this.rebuildDisplay(new Set());
    this.rejections.emit(batchId, reason);
    this.pendingChanges.emit();
  }

  /** display = confirmed + pending, then reports which nodes changed. */
  private rebuildDisplay(touched: Set<NodeId>, author?: string): void {
    const prev = this.display;
    const next = this.confirmed.clone();
    const replayTouched = new Set<NodeId>();
    for (const b of this.pending) for (const op of b.ops) next.apply(op, replayTouched);
    const candidates = new Set([...touched, ...this.pendingTouched, ...replayTouched]);
    this.pendingTouched = replayTouched;
    this.display = next;
    const changed = new Set<NodeId>();
    for (const id of candidates) if (prev.get(id) !== next.get(id)) changed.add(id);
    if (changed.size > 0) this.changes.emit(changed, 'remote', author);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.statusChanges.emit(status);
  }
}

export { EMPTY_PRESENCE };
