import type { FastifyBaseLogger } from 'fastify';
import { Room, RoomServer, CLOSE, type CommittedBatch, type Identity } from '@tandem/room';
import type { Metrics } from './metrics.ts';
import type { Store } from './store.ts';

export interface RoomHost {
  docId: string;
  server: RoomServer;
  lastSnapshotSeq: number;
  idleTimer: NodeJS.Timeout | null;
  unloading: Promise<void> | null;
}

export interface RoomManagerOptions {
  store: Store;
  identity: Identity;
  metrics: Metrics;
  log: FastifyBaseLogger;
  idleSeconds: number;
  snapshotEvery: number;
  commitDelayMs: number;
}

/**
 * Loads each document into one RoomServer while anyone is connected, and
 * wires it to storage: group-committed batch appends, periodic snapshots,
 * and unloading (with a final snapshot) once the room has been idle.
 */
export class RoomManager {
  private readonly hosts = new Map<string, RoomHost>();
  private readonly loading = new Map<string, Promise<RoomHost>>();

  constructor(private readonly options: RoomManagerOptions) {}

  get size(): number {
    return this.hosts.size;
  }

  get(docId: string): RoomHost | undefined {
    return this.hosts.get(docId);
  }

  /** The loaded room for `docId`, loading it once if needed. */
  async acquire(docId: string, docName: string): Promise<RoomHost> {
    for (;;) {
      const host = this.hosts.get(docId);
      if (host && !host.unloading) {
        this.cancelIdle(host);
        return host;
      }
      if (host?.unloading) {
        await host.unloading;
        continue;
      }
      let pending = this.loading.get(docId);
      if (!pending) {
        pending = this.load(docId, docName).finally(() => this.loading.delete(docId));
        this.loading.set(docId, pending);
      }
      return pending;
    }
  }

  /** Call when a connection leaves; starts the idle timer at zero. */
  released(host: RoomHost): void {
    if (host.server.connectionCount > 0 || host.unloading) return;
    this.cancelIdle(host);
    host.idleTimer = setTimeout(() => void this.unload(host), this.options.idleSeconds * 1000);
    host.idleTimer.unref();
  }

  /** Drains, snapshots and unloads every room (graceful shutdown). */
  async shutdown(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((h) => this.unload(h, true)));
  }

  private async load(docId: string, docName: string): Promise<RoomHost> {
    const { store, identity, metrics, log, snapshotEvery, commitDelayMs } = this.options;
    const stored = await store.loadRoom(docId);
    const room = Room.restore(stored.snapshot, stored.batches);
    const host: RoomHost = {
      docId,
      server: null!,
      lastSnapshotSeq: stored.snapshot?.seq ?? 0,
      idleTimer: null,
      unloading: null,
    };
    host.server = new RoomServer(room, {
      docId,
      docName,
      identity,
      schedule: (fn) => setTimeout(fn, commitDelayMs),
      persist: async (batches: CommittedBatch[]) => {
        const end = metrics.persistSeconds.startTimer();
        await store.appendBatches(docId, batches);
        end();
        metrics.batchesCommitted.inc(batches.length);
        metrics.opsApplied.inc(batches.reduce((n, b) => n + b.ops.length, 0));
        const lastSeq = batches.at(-1)!.seq;
        // Snapshot only at a point where memory equals storage, so a
        // snapshot never contains a batch the log does not.
        if (room.seq === lastSeq && lastSeq - host.lastSnapshotSeq >= snapshotEvery) {
          await store.saveSnapshot(docId, room.snapshot());
          host.lastSnapshotSeq = lastSeq;
        }
      },
      onFatal: (err) => {
        log.error({ err, docId }, 'persist failed; resetting room');
        this.drop(host);
      },
    });
    this.hosts.set(docId, host);
    metrics.activeRooms.set(this.hosts.size);
    log.info({ docId, seq: room.seq, nodes: room.doc.size }, 'room loaded');
    return host;
  }

  private async unload(host: RoomHost, force = false): Promise<void> {
    if (host.unloading) return host.unloading;
    if (!force && host.server.connectionCount > 0) return;
    this.cancelIdle(host);
    host.unloading = (async () => {
      const { store, log } = this.options;
      if (force) {
        host.server.closeAll(CLOSE.goingAway, {
          code: 'server_shutdown',
          message: 'server is restarting',
        });
      }
      try {
        await host.server.drain();
        const room = host.server.room;
        if (room.seq > host.lastSnapshotSeq) {
          await store.saveSnapshot(host.docId, room.snapshot());
          host.lastSnapshotSeq = room.seq;
        }
        log.info({ docId: host.docId, seq: room.seq }, 'room unloaded');
      } catch (err) {
        log.error({ err, docId: host.docId }, 'failed to unload room cleanly');
      } finally {
        this.drop(host);
      }
    })();
    return host.unloading;
  }

  private drop(host: RoomHost): void {
    this.cancelIdle(host);
    if (this.hosts.get(host.docId) === host) this.hosts.delete(host.docId);
    this.options.metrics.activeRooms.set(this.hosts.size);
  }

  private cancelIdle(host: RoomHost): void {
    if (host.idleTimer) clearTimeout(host.idleTimer);
    host.idleTimer = null;
  }
}
