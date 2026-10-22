import { Document, type NodeId, type NodeProps, type Op } from '@murmuration/doc-model';

/** A batch the room accepted, in the order it was applied. */
export interface CommittedBatch {
  seq: number;
  clientId: string;
  batchId: number;
  ops: Op[];
}

export type SubmitResult =
  | { kind: 'applied'; batch: CommittedBatch }
  /** Already processed (applied or rejected) — a resend after a lost ack. */
  | { kind: 'duplicate' }
  | { kind: 'rejected'; reason: string };

export interface RoomSnapshot {
  seq: number;
  nodes: Array<[NodeId, NodeProps]>;
  /** Highest batchId processed per client, for deduplication. */
  clients: Record<string, number>;
}

export interface RoomOptions {
  /** How many recent batches to keep for reconnect catch-up. */
  historyLimit?: number;
}

/**
 * The authoritative state of one document. It serialises batches, assigns
 * each one a seq, and remembers recent batches so reconnecting clients can
 * catch up without a full snapshot. It does no I/O: the server persists
 * `CommittedBatch`es and the simulator uses this class directly.
 */
export class Room {
  readonly doc: Document;
  private seqValue: number;
  private readonly lastBatch: Map<string, number>;
  private readonly history: CommittedBatch[] = [];
  private readonly historyLimit: number;

  constructor(snapshot?: RoomSnapshot, options: RoomOptions = {}) {
    this.doc = snapshot ? Document.fromEntries(snapshot.nodes) : new Document();
    this.seqValue = snapshot?.seq ?? 0;
    this.lastBatch = new Map(Object.entries(snapshot?.clients ?? {}));
    this.historyLimit = options.historyLimit ?? 10_000;
  }

  /** Rebuilds a room from a snapshot plus the batches committed after it. */
  static restore(
    snapshot: RoomSnapshot | null,
    batches: readonly CommittedBatch[],
    options?: RoomOptions,
  ): Room {
    const room = new Room(snapshot ?? undefined, options);
    for (const batch of batches) {
      if (batch.seq <= room.seqValue) continue;
      if (batch.seq !== room.seqValue + 1) {
        throw new Error(`gap in batch log: expected seq ${room.seqValue + 1}, got ${batch.seq}`);
      }
      const res = room.doc.applyBatch(batch.ops);
      if (!res.ok) throw new Error(`stored batch ${batch.seq} no longer applies: ${res.reason}`);
      room.seqValue = batch.seq;
      room.lastBatch.set(
        batch.clientId,
        Math.max(batch.batchId, room.ackedThrough(batch.clientId)),
      );
      room.remember(batch);
    }
    return room;
  }

  get seq(): number {
    return this.seqValue;
  }

  ackedThrough(clientId: string): number {
    return this.lastBatch.get(clientId) ?? 0;
  }

  submit(clientId: string, batchId: number, ops: Op[]): SubmitResult {
    if (batchId <= this.ackedThrough(clientId)) return { kind: 'duplicate' };
    this.lastBatch.set(clientId, batchId);
    const res = this.doc.applyBatch(ops);
    if (!res.ok) return { kind: 'rejected', reason: `op ${res.opIndex}: ${res.reason}` };
    const batch: CommittedBatch = { seq: ++this.seqValue, clientId, batchId, ops };
    this.remember(batch);
    return { kind: 'applied', batch };
  }

  /**
   * Batches with seq > `afterSeq`, or null when history no longer reaches
   * back that far (or `afterSeq` is from a future this room never saw).
   */
  batchesSince(afterSeq: number): CommittedBatch[] | null {
    if (afterSeq > this.seqValue) return null;
    if (afterSeq === this.seqValue) return [];
    const first = this.history[0];
    if (!first || first.seq > afterSeq + 1) return null;
    return this.history.slice(afterSeq + 1 - first.seq);
  }

  snapshot(): RoomSnapshot {
    return {
      seq: this.seqValue,
      nodes: this.doc.toEntries(),
      clients: Object.fromEntries(this.lastBatch),
    };
  }

  private remember(batch: CommittedBatch): void {
    this.history.push(batch);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
  }
}
