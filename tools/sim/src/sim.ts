import fc from 'fast-check';
import {
  ROOT_ID,
  defaultProps,
  keyBetweenJittered,
  type Document,
  type NodeId,
  type Op,
  type PropKey,
} from '@tandem/doc-model';
import { PROTOCOL_VERSION, encode, parseClientMessage, type ServerMessage } from '@tandem/protocol';
import {
  Room,
  RoomServer,
  type CommittedBatch,
  type Identity,
  type RoomConnection,
  type RoomSnapshot,
} from '@tandem/room';
import { SyncClient } from '@tandem/sync-client';

/**
 * Convergence simulator. One in-process server (the real Room + RoomServer)
 * and several real SyncClients exchange serialised messages over simulated
 * links. A list of abstract actions drives everything: local edits, undo,
 * message delivery in any interleaving, disconnects, reconnects and server
 * crashes. After the actions, the network is drained and every client must
 * hold exactly the server's document.
 */

export type ActionKind =
  | 'edit'
  | 'drag'
  | 'undo'
  | 'redo'
  | 'flushClient'
  | 'toServer'
  | 'toClient'
  | 'serverFlush'
  | 'disconnect'
  | 'reconnect'
  | 'crashServer';

export interface Action {
  kind: ActionKind;
  client: number;
  a: number;
  b: number;
  c: number;
}

const WEIGHTS: Array<[ActionKind, number]> = [
  ['edit', 80],
  ['drag', 16],
  ['undo', 16],
  ['redo', 8],
  ['flushClient', 48],
  ['toServer', 80],
  ['toClient', 96],
  ['serverFlush', 40],
  ['disconnect', 6],
  ['reconnect', 16],
  ['crashServer', 1],
];

export const actionArbitrary: fc.Arbitrary<Action> = fc.record({
  kind: fc.oneof(...WEIGHTS.map(([k, w]) => ({ arbitrary: fc.constant(k), weight: w }))),
  client: fc.nat(),
  a: fc.nat(),
  b: fc.nat(),
  c: fc.nat(),
});

export interface SimOptions {
  clients: number;
  /** Indexes of clients that join with a view-only link. */
  viewers?: number[];
  /** Check document invariants after every action (slower). */
  checkEveryStep?: boolean;
}

export interface SimStats {
  actions: number;
  nodes: number;
  seq: number;
  crashes: number;
  messages: number;
}

const DOC_ID = 'sim-doc';
const COLORS = ['#ff0000ff', '#00ff00ff', '#0000ffff', '#222222ff', null] as const;

const identity = (): Identity => {
  let n = 0;
  return {
    newClientId: () => `c${++n}`,
    sign: (doc, id) => `${doc}/${id}`,
    verify: (doc, id, sig) => sig === `${doc}/${id}`,
  };
};

class SimConn implements RoomConnection {
  closed = false;
  constructor(
    private readonly sim: Simulation,
    readonly client: SimClient,
  ) {}
  send(msg: ServerMessage): void {
    if (!this.closed) {
      this.client.toClient.push(encode(msg));
      this.sim.messages++;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sim.dropConnection(this.client);
  }
}

class SimClient {
  readonly sync: SyncClient;
  conn: SimConn | null = null;
  joined = false;
  toServer: string[] = [];
  toClient: string[] = [];

  constructor(
    readonly index: number,
    readonly role: 'edit' | 'view',
  ) {
    this.sync = new SyncClient({ docId: DOC_ID, token: role, name: `client ${index}` });
  }
}

export class Simulation {
  readonly clients: SimClient[];
  messages = 0;
  crashes = 0;
  private store: { snapshot: RoomSnapshot | null; log: CommittedBatch[] } = {
    snapshot: null,
    log: [],
  };
  private server!: RoomServer;
  private scheduled: Array<() => void> = [];
  private readonly identity = identity();

  constructor(private readonly options: SimOptions) {
    this.startServer();
    this.clients = Array.from(
      { length: options.clients },
      (_, i) => new SimClient(i, options.viewers?.includes(i) ? 'view' : 'edit'),
    );
    for (const c of this.clients) this.connect(c);
  }

  get room(): Room {
    return this.server.room;
  }

  run(actions: readonly Action[]): SimStats {
    for (const action of actions) {
      this.step(action);
      if (this.options.checkEveryStep) this.checkInvariants();
    }
    this.quiesce();
    this.checkConverged();
    return {
      actions: actions.length,
      nodes: this.room.doc.size,
      seq: this.room.seq,
      crashes: this.crashes,
      messages: this.messages,
    };
  }

  step(action: Action): void {
    const client = this.clients[action.client % this.clients.length]!;
    switch (action.kind) {
      case 'edit':
        if (client.sync.isReady) client.sync.apply(this.randomOps(client, action));
        break;
      case 'drag':
        this.drag(client, action);
        break;
      case 'undo':
        client.sync.undo();
        break;
      case 'redo':
        client.sync.redo();
        break;
      case 'flushClient':
        client.sync.flush();
        break;
      case 'toServer':
        this.deliverToServer(client);
        break;
      case 'toClient':
        this.deliverToClient(client);
        break;
      case 'serverFlush':
        this.scheduled.shift()?.();
        break;
      case 'disconnect':
        if (client.conn) client.conn.close();
        break;
      case 'reconnect':
        if (!client.conn) this.connect(client);
        break;
      case 'crashServer':
        this.crashServer();
        break;
    }
  }

  dropConnection(client: SimClient): void {
    // Messages in flight on a dead socket are lost in both directions.
    client.toServer = [];
    client.toClient = [];
    if (client.conn) this.server.leave(client.conn);
    client.conn = null;
    client.joined = false;
    client.sync.disconnect();
  }

  /** Delivers everything until no client has unsent or unconfirmed work. */
  quiesce(): void {
    for (const c of this.clients) if (!c.conn) this.connect(c);
    for (let round = 0; round < 10_000; round++) {
      let progressed = false;
      for (const c of this.clients) {
        c.sync.flush();
        while (c.toServer.length > 0) {
          this.deliverToServer(c);
          progressed = true;
        }
      }
      while (this.scheduled.length > 0) {
        this.scheduled.shift()!();
        progressed = true;
      }
      for (const c of this.clients) {
        while (c.toClient.length > 0) {
          this.deliverToClient(c);
          progressed = true;
        }
      }
      const idle = this.clients.every((c) => c.sync.pendingOpCount === 0 || c.role === 'view');
      if (!progressed && idle) return;
    }
    throw new Error('network did not quiesce');
  }

  checkInvariants(): void {
    this.room.doc.assertInvariants();
    for (const c of this.clients) {
      c.sync.confirmed.assertInvariants();
      c.sync.display.assertInvariants();
    }
  }

  checkConverged(): void {
    this.checkInvariants();
    const truth = this.room.doc;
    for (const c of this.clients) {
      if (c.sync.status !== 'connected') throw new Error(`client ${c.index} is not connected`);
      if (c.sync.pendingOpCount !== 0) throw new Error(`client ${c.index} still has pending ops`);
      if (c.sync.confirmedSeq !== this.room.seq) {
        throw new Error(
          `client ${c.index} at seq ${c.sync.confirmedSeq}, server at ${this.room.seq}`,
        );
      }
      if (!c.sync.confirmed.equals(truth))
        throw new Error(`client ${c.index} confirmed state diverged`);
      if (!c.sync.display.equals(truth))
        throw new Error(`client ${c.index} display state diverged`);
    }
  }

  // ------------------------------------------------------------- network

  private connect(client: SimClient): void {
    client.conn = new SimConn(this, client);
    client.joined = false;
    client.sync.connect((raw) => client.toServer.push(raw));
  }

  private deliverToServer(client: SimClient): void {
    const raw = client.toServer.shift();
    if (raw === undefined || !client.conn) return;
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) throw new Error(`client sent an unparseable message: ${parsed.error}`);
    const msg = parsed.message;
    if (!client.joined) {
      if (msg.type !== 'hello') throw new Error('first message was not hello');
      if (msg.protocolVersion !== PROTOCOL_VERSION) throw new Error('protocol mismatch');
      client.joined = true;
      this.server.join(client.conn, msg, client.role);
      return;
    }
    this.server.message(client.conn, msg);
  }

  private deliverToClient(client: SimClient): void {
    const raw = client.toClient.shift();
    if (raw !== undefined) client.sync.receive(raw);
  }

  private startServer(): void {
    const room = Room.restore(this.store.snapshot, this.store.log);
    // Compact like the real server: a fresh snapshot replaces the log.
    this.store = { snapshot: room.snapshot(), log: [] };
    this.scheduled = [];
    this.server = new RoomServer(room, {
      docId: DOC_ID,
      docName: 'Simulated',
      identity: this.identity,
      schedule: (fn) => this.scheduled.push(fn),
      persist: (batches) => {
        this.store.log.push(...(JSON.parse(JSON.stringify(batches)) as CommittedBatch[]));
      },
    });
  }

  private crashServer(): void {
    this.crashes++;
    // Unflushed batches were never persisted or acked; they are lost with
    // the process, and clients must resend them.
    for (const c of this.clients) {
      if (c.conn) {
        c.conn.closed = true;
        this.dropConnection(c);
      }
    }
    this.startServer();
  }

  // ------------------------------------------------------------- edits

  private sortedIds(doc: Document): NodeId[] {
    return [...doc.ids()].sort();
  }

  private frames(doc: Document): NodeId[] {
    return this.sortedIds(doc).filter((id) => doc.get(id)!.type === 'frame');
  }

  private indexAmong(doc: Document, parent: NodeId, pos: number, salt: number): string {
    const sibs = doc.childrenOf(parent);
    const at = pos % (sibs.length + 1);
    const before = at > 0 ? doc.get(sibs[at - 1]!)!.index : null;
    const after = at < sibs.length ? doc.get(sibs[at]!)!.index : null;
    if (before !== null && after !== null && before >= after) return before;
    return keyBetweenJittered(before, after, () => (salt % 997) / 997);
  }

  private randomOps(client: SimClient, { a, b, c }: Action): Op[] {
    const doc = client.sync.display;
    const ids = this.sortedIds(doc);
    const choice = ids.length === 0 ? 0 : a % 10;
    if (choice <= 2) {
      const frames = this.frames(doc);
      const parent = b % 3 === 0 || frames.length === 0 ? ROOT_ID : frames[b % frames.length]!;
      const type = c % 4 === 0 ? 'frame' : c % 4 === 1 ? 'ellipse' : 'rect';
      const props = defaultProps(type, {
        parentId: parent,
        index: this.indexAmong(doc, parent, c, a),
        x: (a % 2000) - 1000,
        y: (b % 2000) - 1000,
      });
      return [{ t: 'create', id: client.sync.newNodeId(), props }];
    }
    const id = ids[b % ids.length]!;
    if (choice === 3) return [{ t: 'delete', id }];
    if (choice === 4) {
      const frames = this.frames(doc);
      const options = [ROOT_ID, ...frames];
      const parent = options[c % options.length]!;
      return [
        { t: 'set', id, key: 'parentId', value: parent },
        { t: 'set', id, key: 'index', value: this.indexAmong(doc, parent, a, c) },
      ];
    }
    if (choice === 5) {
      const parent = doc.get(id)!.parentId;
      return [{ t: 'set', id, key: 'index', value: this.indexAmong(doc, parent, c, a) }];
    }
    const keys: PropKey[] = ['x', 'y', 'fill', 'width', 'name'];
    const key = keys[c % keys.length]!;
    const value =
      key === 'fill' ? COLORS[a % COLORS.length]! : key === 'name' ? `n${a % 50}` : a % 500;
    return [{ t: 'set', id, key, value }];
  }

  /** A gesture: many sets of the same properties inside one transaction. */
  private drag(client: SimClient, { a, b, c }: Action): void {
    const doc = client.sync.display;
    const ids = this.sortedIds(doc);
    if (!client.sync.isReady || ids.length === 0) return;
    const moving = [ids[a % ids.length]!, ids[b % ids.length]!];
    client.sync.beginTransaction();
    for (let i = 0; i < 2 + (c % 6); i++) {
      for (const id of moving) {
        client.sync.apply([
          { t: 'set', id, key: 'x', value: (a + i * 7) % 1000 },
          { t: 'set', id, key: 'y', value: (b + i * 3) % 1000 },
        ]);
      }
      if (i === 1 && c % 2 === 0) client.sync.flush();
    }
    client.sync.commitTransaction();
  }
}

export function runSimulation(actions: readonly Action[], options: SimOptions): SimStats {
  return new Simulation(options).run(actions);
}

/** Deterministic action list for a seed, for the CLI and nightly runs. */
export function actionsForSeed(seed: number, length: number): Action[] {
  return fc.sample(fc.array(actionArbitrary, { minLength: length, maxLength: length }), {
    seed,
    numRuns: 1,
  })[0]!;
}
