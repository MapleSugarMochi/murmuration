import type { CommittedBatch, RoomSnapshot } from '@tandem/room';

export interface DocMeta {
  id: string;
  name: string;
  editTokenHash: string;
  viewTokenHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredRoom {
  snapshot: RoomSnapshot | null;
  /** Batches committed after the snapshot, in seq order. */
  batches: CommittedBatch[];
}

/** Durable storage for documents. Implementations: memory and Postgres. */
export interface Store {
  createDoc(meta: DocMeta): Promise<void>;
  getDoc(id: string): Promise<DocMeta | null>;
  renameDoc(id: string, name: string): Promise<void>;
  setTokenHashes(id: string, editTokenHash: string, viewTokenHash: string): Promise<void>;
  loadRoom(id: string): Promise<StoredRoom>;
  /** Appends batches atomically; they must continue the stored seq. */
  appendBatches(id: string, batches: CommittedBatch[]): Promise<void>;
  saveSnapshot(id: string, snapshot: RoomSnapshot): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

const clone = <T>(v: T): T => structuredClone(v);

/** In-process store for development and tests. Data is lost on restart. */
export class MemoryStore implements Store {
  private readonly docs = new Map<string, DocMeta>();
  private readonly rooms = new Map<string, StoredRoom>();
  /** Test hook: make the next appendBatches call fail. */
  failNextAppend = false;

  async createDoc(meta: DocMeta): Promise<void> {
    if (this.docs.has(meta.id)) throw new Error('document exists');
    this.docs.set(meta.id, clone(meta));
    this.rooms.set(meta.id, { snapshot: null, batches: [] });
  }

  async getDoc(id: string): Promise<DocMeta | null> {
    const doc = this.docs.get(id);
    return doc ? clone(doc) : null;
  }

  async renameDoc(id: string, name: string): Promise<void> {
    const doc = this.docs.get(id);
    if (doc) Object.assign(doc, { name, updatedAt: new Date() });
  }

  async setTokenHashes(id: string, editTokenHash: string, viewTokenHash: string): Promise<void> {
    const doc = this.docs.get(id);
    if (doc) Object.assign(doc, { editTokenHash, viewTokenHash, updatedAt: new Date() });
  }

  async loadRoom(id: string): Promise<StoredRoom> {
    return clone(this.rooms.get(id) ?? { snapshot: null, batches: [] });
  }

  async appendBatches(id: string, batches: CommittedBatch[]): Promise<void> {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error('simulated storage failure');
    }
    const room = this.rooms.get(id);
    if (!room) throw new Error('unknown document');
    const last = room.batches.at(-1)?.seq ?? room.snapshot?.seq ?? 0;
    if (batches[0] && batches[0].seq !== last + 1) throw new Error('non-contiguous append');
    room.batches.push(...clone(batches));
  }

  async saveSnapshot(id: string, snapshot: RoomSnapshot): Promise<void> {
    const room = this.rooms.get(id);
    if (!room) return;
    room.snapshot = clone(snapshot);
    room.batches = room.batches.filter((b) => b.seq > snapshot.seq);
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {}
}
