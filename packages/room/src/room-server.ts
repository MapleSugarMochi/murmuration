import {
  EMPTY_PRESENCE,
  PEER_COLORS,
  type ClientMessage,
  type ErrorCode,
  type HelloMessage,
  type OpsMessage,
  type PeerInfo,
  type PresenceState,
  type Role,
  type ServerMessage,
  type WelcomeMessage,
} from '@tandem/protocol';
import type { CommittedBatch, Room } from './room.ts';

export interface RoomConnection {
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

/** Issues client ids and proves them across reconnects. */
export interface Identity {
  newClientId(): string;
  sign(docId: string, clientId: string): string;
  verify(docId: string, clientId: string, sig: string): boolean;
}

export interface RoomServerOptions {
  docId: string;
  docName: string;
  /**
   * Makes batches durable. May be async; calls never overlap and batches
   * arrive in seq order. Acks and broadcasts wait for it to finish.
   */
  persist(batches: CommittedBatch[]): void | Promise<void>;
  /** Runs `fn` soon; used to group several batches into one persist call. */
  schedule(fn: () => void): void;
  identity: Identity;
  /** Persistence failed; in-memory state is ahead of storage. */
  onFatal?(error: unknown): void;
}

interface ConnState {
  clientId: string;
  name: string;
  color: string;
  role: Role;
  presence: PresenceState;
  /** Set once the welcome has been sent; ordered messages wait for it. */
  welcomed: boolean;
}

type OutEvent =
  | { kind: 'batch'; batch: CommittedBatch; author: RoomConnection }
  | { kind: 'reject'; conn: RoomConnection; batchId: number; reason: string }
  | { kind: 'welcome'; conn: RoomConnection; msg: WelcomeMessage };

/** WebSocket close codes used by the server. */
export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  policy: 1008,
  tooBig: 1009,
  internal: 1011,
  replaced: 4000,
} as const;

/**
 * Protocol handling for one document, independent of sockets and storage.
 *
 * Every message whose meaning depends on document order — welcome, ack,
 * reject, ops — goes through one queue that is released only after the
 * batches before it are persisted. So a client never sees a seq that could
 * be lost in a crash, and each connection sees messages in seq order.
 */
export class RoomServer {
  readonly room: Room;
  private readonly options: RoomServerOptions;
  private readonly conns = new Map<RoomConnection, ConnState>();
  private queue: OutEvent[] = [];
  private flushScheduled = false;
  private flushing: Promise<void> | null = null;
  private colorCursor = 0;
  private docName: string;
  private dead = false;

  constructor(room: Room, options: RoomServerOptions) {
    this.room = room;
    this.options = options;
    this.docName = options.docName;
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  get clientIds(): string[] {
    return [...this.conns.values()].map((s) => s.clientId);
  }

  /** Admits an authenticated connection; `role` comes from its token. */
  join(conn: RoomConnection, hello: HelloMessage, role: Role): void {
    if (this.dead) {
      this.fail(conn, 'room_reset', 'room is restarting');
      return;
    }
    const { docId, identity } = this.options;
    let clientId: string | null = null;
    const resumed =
      hello.resume !== undefined && identity.verify(docId, hello.resume.clientId, hello.resume.sig);
    if (resumed) {
      clientId = hello.resume!.clientId;
      // A reconnect can overtake the old socket's close; replace it.
      for (const [other, st] of this.conns) {
        if (st.clientId === clientId) {
          this.conns.delete(other);
          other.close(CLOSE.replaced, 'replaced by a newer connection');
        }
      }
    }
    clientId ??= identity.newClientId();

    const state: ConnState = {
      clientId,
      name: hello.name,
      color: PEER_COLORS[this.colorCursor++ % PEER_COLORS.length]!,
      role,
      presence: EMPTY_PRESENCE,
      welcomed: false,
    };
    this.conns.set(conn, state);

    const catchUp =
      resumed && hello.lastSeq !== undefined ? this.room.batchesSince(hello.lastSeq) : null;
    const welcome: WelcomeMessage = {
      type: 'welcome',
      clientId,
      resumeSig: identity.sign(docId, clientId),
      role,
      name: state.name,
      color: state.color,
      docName: this.docName,
      seq: this.room.seq,
      ackedThrough: this.room.ackedThrough(clientId),
      // Filled in at dispatch, when the set of welcomed peers is final.
      peers: [],
      ...(catchUp ? { ops: catchUp.map(toOpsMessage) } : { snapshot: this.room.doc.toEntries() }),
    };
    this.push({ kind: 'welcome', conn, msg: welcome });
  }

  message(conn: RoomConnection, msg: ClientMessage): void {
    const state = this.conns.get(conn);
    if (!state) return;
    switch (msg.type) {
      case 'hello':
        this.fail(conn, 'bad_message', 'already joined');
        return;
      case 'ping':
        conn.send({ type: 'pong', t: msg.t });
        return;
      case 'presence': {
        const { type: _type, ...fields } = msg;
        state.presence = { ...state.presence, ...fields };
        if (state.welcomed) {
          this.broadcastNow(conn, {
            type: 'presence',
            clientId: state.clientId,
            presence: state.presence,
          });
        }
        return;
      }
      case 'batch': {
        if (!state.welcomed) return;
        if (state.role !== 'edit') {
          this.push({ kind: 'reject', conn, batchId: msg.batchId, reason: 'read only' });
          return;
        }
        const res = this.room.submit(state.clientId, msg.batchId, msg.ops);
        if (res.kind === 'applied') this.push({ kind: 'batch', batch: res.batch, author: conn });
        else if (res.kind === 'rejected') {
          this.push({ kind: 'reject', conn, batchId: msg.batchId, reason: res.reason });
        }
        return;
      }
    }
  }

  leave(conn: RoomConnection): void {
    const state = this.conns.get(conn);
    if (!state) return;
    this.conns.delete(conn);
    if (state.welcomed) this.broadcastNow(conn, { type: 'peer-leave', clientId: state.clientId });
  }

  rename(name: string): void {
    this.docName = name;
    this.broadcastNow(null, { type: 'doc-renamed', name });
  }

  /** Sends an error to everyone and closes all connections. */
  closeAll(code: number, error: { code: ErrorCode; message: string }): void {
    for (const conn of [...this.conns.keys()]) {
      conn.send({ type: 'error', code: error.code, message: error.message, fatal: true });
      conn.close(code, error.message);
    }
    this.conns.clear();
  }

  /** Resolves once every queued batch is persisted and dispatched. */
  async drain(): Promise<void> {
    while (!this.dead && (this.queue.length > 0 || this.flushing)) {
      if (this.flushing) await this.flushing;
      else this.flush();
    }
  }

  private push(event: OutEvent): void {
    this.queue.push(event);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.flushing) return;
    this.flushScheduled = true;
    this.options.schedule(() => this.flush());
  }

  /** Persists the queued batches, then dispatches every queued event. */
  private flush(): void {
    this.flushScheduled = false;
    if (this.flushing || this.dead || this.queue.length === 0) return;
    const events = this.queue;
    this.queue = [];
    const batches: CommittedBatch[] = [];
    for (const e of events) if (e.kind === 'batch') batches.push(e.batch);

    const done = () => {
      this.flushing = null;
      this.dispatch(events);
      if (this.queue.length > 0) this.scheduleFlush();
    };
    const onError = (err: unknown) => {
      this.flushing = null;
      this.dead = true;
      this.closeAll(CLOSE.internal, { code: 'room_reset', message: 'storage failure' });
      this.options.onFatal?.(err);
    };

    let result: void | Promise<void>;
    try {
      result = batches.length > 0 ? this.options.persist(batches) : undefined;
    } catch (err) {
      onError(err);
      return;
    }
    if (result instanceof Promise) {
      this.flushing = result.then(done, onError);
    } else {
      done();
    }
  }

  private dispatch(events: OutEvent[]): void {
    for (const e of events) {
      switch (e.kind) {
        case 'welcome': {
          const state = this.conns.get(e.conn);
          if (!state) break;
          e.conn.send({ ...e.msg, peers: this.peerList(e.conn) });
          state.welcomed = true;
          this.broadcastNow(e.conn, { type: 'peer-join', peer: this.peerInfo(state) });
          break;
        }
        case 'reject':
          if (this.conns.get(e.conn)?.welcomed) {
            e.conn.send({ type: 'reject', batchId: e.batchId, reason: e.reason });
          }
          break;
        case 'batch': {
          const ops = toOpsMessage(e.batch);
          for (const [conn, state] of this.conns) {
            if (!state.welcomed) continue;
            if (conn === e.author)
              conn.send({ type: 'ack', batchId: e.batch.batchId, seq: e.batch.seq });
            else conn.send(ops);
          }
          break;
        }
      }
    }
  }

  /** For messages with no ordering relative to document state. */
  private broadcastNow(except: RoomConnection | null, msg: ServerMessage): void {
    for (const [conn, state] of this.conns) {
      if (conn !== except && state.welcomed) conn.send(msg);
    }
  }

  private fail(conn: RoomConnection, code: ErrorCode, message: string): void {
    conn.send({ type: 'error', code, message, fatal: true });
    conn.close(CLOSE.policy, message);
    this.leave(conn);
  }

  private peerInfo(state: ConnState): PeerInfo {
    return {
      clientId: state.clientId,
      name: state.name,
      color: state.color,
      role: state.role,
      presence: state.presence,
    };
  }

  private peerList(except: RoomConnection): PeerInfo[] {
    const peers: PeerInfo[] = [];
    for (const [conn, state] of this.conns) {
      if (conn !== except && state.welcomed) peers.push(this.peerInfo(state));
    }
    return peers;
  }
}

function toOpsMessage(batch: CommittedBatch): OpsMessage {
  return {
    type: 'ops',
    seq: batch.seq,
    clientId: batch.clientId,
    batchId: batch.batchId,
    ops: batch.ops,
  };
}
