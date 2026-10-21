import { z } from 'zod';
import type { NodeId, NodeProps, Op } from '@tandem/doc-model';

/** Bump on any incompatible change to the messages below. */
export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  /** Largest WebSocket message either side accepts, in bytes. */
  messageBytes: 256 * 1024,
  opsPerBatch: 500,
  selection: 1_000,
  chat: 140,
  name: 40,
} as const;

export type Role = 'edit' | 'view';

// Op shapes are checked loosely here; doc-model validates every value.
const opSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('create'), id: z.string(), props: z.record(z.unknown()) }),
  z.object({ t: z.literal('set'), id: z.string(), key: z.string(), value: z.unknown() }),
  z.object({ t: z.literal('delete'), id: z.string() }),
]);

const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
const viewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().finite().positive(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});

export type Point = z.infer<typeof pointSchema>;
export type Viewport = z.infer<typeof viewportSchema>;

export interface PresenceState {
  cursor: Point | null;
  selection: NodeId[];
  viewport: Viewport | null;
  chat: string | null;
}

export const EMPTY_PRESENCE: PresenceState = {
  cursor: null,
  selection: [],
  viewport: null,
  chat: null,
};

const presenceFields = {
  cursor: pointSchema.nullable().optional(),
  selection: z.array(z.string()).max(LIMITS.selection).optional(),
  viewport: viewportSchema.nullable().optional(),
  chat: z.string().max(LIMITS.chat).nullable().optional(),
};

// ---------------------------------------------------------------- client → server

const helloSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number().int(),
  docId: z.string().min(1).max(64),
  /** The share-link token (edit or view). */
  token: z.string().min(1).max(128),
  name: z.string().min(1).max(LIMITS.name),
  /** Present when reconnecting, to keep the same client id. */
  resume: z.object({ clientId: z.string().max(64), sig: z.string().max(128) }).optional(),
  /** Highest seq this client has applied. */
  lastSeq: z.number().int().nonnegative().optional(),
});

const batchSchema = z.object({
  type: z.literal('batch'),
  batchId: z.number().int().positive(),
  ops: z.array(opSchema).min(1).max(LIMITS.opsPerBatch),
});

const clientPresenceSchema = z.object({ type: z.literal('presence'), ...presenceFields });
const pingSchema = z.object({ type: z.literal('ping'), t: z.number() });

const clientMessageSchema = z.discriminatedUnion('type', [
  helloSchema,
  batchSchema,
  clientPresenceSchema,
  pingSchema,
]);

export type HelloMessage = z.infer<typeof helloSchema>;
export type BatchMessage = { type: 'batch'; batchId: number; ops: Op[] };
export type ClientPresenceMessage = z.infer<typeof clientPresenceSchema>;
export type PingMessage = z.infer<typeof pingSchema>;
export type ClientMessage = HelloMessage | BatchMessage | ClientPresenceMessage | PingMessage;

// ---------------------------------------------------------------- server → client

export interface PeerInfo {
  clientId: string;
  name: string;
  color: string;
  role: Role;
  presence: PresenceState;
}

export interface OpsMessage {
  type: 'ops';
  seq: number;
  clientId: string;
  batchId: number;
  ops: Op[];
}

export interface WelcomeMessage {
  type: 'welcome';
  clientId: string;
  /** Proof of `clientId` to present in `hello.resume` on reconnect. */
  resumeSig: string;
  role: Role;
  name: string;
  color: string;
  docName: string;
  /** The seq of the state described by `snapshot` or reached after `ops`. */
  seq: number;
  /** The highest batchId from this client the server has processed. */
  ackedThrough: number;
  /** Either a full snapshot, or the batches after the client's `lastSeq`. */
  snapshot?: Array<[NodeId, NodeProps]>;
  ops?: OpsMessage[];
  peers: PeerInfo[];
}

export interface AckMessage {
  type: 'ack';
  batchId: number;
  seq: number;
}

export interface RejectMessage {
  type: 'reject';
  batchId: number;
  reason: string;
}

export interface ServerPresenceMessage {
  type: 'presence';
  clientId: string;
  presence: PresenceState;
}

export interface PeerJoinMessage {
  type: 'peer-join';
  peer: PeerInfo;
}

export interface PeerLeaveMessage {
  type: 'peer-leave';
  clientId: string;
}

export interface PongMessage {
  type: 'pong';
  t: number;
}

export interface DocRenamedMessage {
  type: 'doc-renamed';
  name: string;
}

export type ErrorCode =
  | 'protocol_version'
  | 'bad_message'
  | 'unauthorized'
  | 'not_found'
  | 'read_only'
  | 'rate_limited'
  | 'links_rotated'
  | 'server_shutdown'
  | 'room_reset'
  | 'internal';

export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  message: string;
  /** When true the server closes the connection after sending. */
  fatal: boolean;
}

export type ServerMessage =
  | WelcomeMessage
  | AckMessage
  | RejectMessage
  | OpsMessage
  | ServerPresenceMessage
  | PeerJoinMessage
  | PeerLeaveMessage
  | PongMessage
  | DocRenamedMessage
  | ErrorMessage;

// ---------------------------------------------------------------- parsing

export type ParseResult<T> = { ok: true; message: T } | { ok: false; error: string };

/** Parses untrusted client input. Op values are validated later by doc-model. */
export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  if (raw.length > LIMITS.messageBytes) return { ok: false, error: 'message too large' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const res = clientMessageSchema.safeParse(json);
  if (!res.success) return { ok: false, error: res.error.issues[0]?.message ?? 'invalid message' };
  return { ok: true, message: res.data as ClientMessage };
}

/**
 * Server messages come from a trusted peer, so the client only checks the
 * envelope. Anything unexpected is surfaced as an error, not thrown.
 */
export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  if (
    typeof json !== 'object' ||
    json === null ||
    typeof (json as { type?: unknown }).type !== 'string'
  ) {
    return { ok: false, error: 'missing message type' };
  }
  return { ok: true, message: json as ServerMessage };
}

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

/** Session colours, assigned round-robin per document. */
export const PEER_COLORS = [
  '#e5484d',
  '#0091ff',
  '#30a46c',
  '#f76b15',
  '#8e4ec6',
  '#d6409f',
  '#12a594',
  '#ad7f58',
] as const;

export { clientMessageSchema };
