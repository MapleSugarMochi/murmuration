# Sync design

Murmuration uses a server-authoritative protocol with per-property last-writer-wins
(LWW). This document explains the model, why it was chosen over the
alternatives, and what it costs.

## The document

A document is a flat table `NodeId → NodeProps`. The tree lives in two
properties of each node: `parentId` and `index` (a fractional index ordering
siblings). So every edit is one of three ops:

| Op                    | Meaning                               |
| --------------------- | ------------------------------------- |
| `create(id, props)`   | add a node with its full property set |
| `set(id, key, value)` | change one property                   |
| `delete(id)`          | remove a node and its subtree         |

Reparenting and reordering are ordinary `set`s, so they need no special conflict
rules. Node ids are `<clientId>:<counter>`; the server issues client ids, so
clients can create nodes offline without collisions.

## Ordering and conflicts

The server is the single authority for each document. It applies batches in
arrival order and stamps each with an increasing `seq`. Two writes to the same
property resolve to whichever reached the server last; writes to different
properties never conflict. If Ada recolours a shape while Bob moves it, both
changes survive.

Some ops lose races rather than conflict. Applying them is deterministic, so
every replica makes the same call:

| Situation                                                           | Outcome                     |
| ------------------------------------------------------------------- | --------------------------- |
| `set` or `delete` on a node that no longer exists                   | dropped                     |
| `create` with an id that is already live                            | dropped                     |
| a `parentId` that would form a cycle (A into B while B goes into A) | dropped                     |
| a `parentId` pointing at a deleted frame                            | dropped                     |
| a malformed value, or a non-frame parent                            | the whole batch is rejected |

Only malformed input is rejected, and it never arises from concurrency.

## The client: confirmed + pending

Each client holds two documents:

- **confirmed**: advances only on server results (`ops` from others, `ack` for
  its own batches);
- **display**: confirmed with every pending local batch replayed on top.

Local edits apply to display at once (optimistic), join an open batch, and are
flushed at most every 40 ms: the first edit after a pause goes out at once,
and during a drag each window carries only the latest values. That keeps a drag
under 5 KB/s of upload, at the cost of up to 40 ms of extra latency for others
(docs/benchmarks.md, PF-08). When the server acks a batch it moves into
confirmed. Remote ops apply to confirmed, then display is rebuilt by replaying
pending batches. Because client and server share the same deterministic
`applyBatch`, display equals confirmed — and equals the server — once nothing is
pending.

Messages to a connection arrive in seq order, so when an ack arrives, confirmed
already contains everything before it and display needs no rebuild.

Within one open batch, repeated `set`s of the same property coalesce (a drag
sends one value per frame, not one per pointer event). Coalescing is suppressed
for `parentId`, whose outcome depends on other nodes, and across a
`create`/`delete` of the same node, so it never changes the result.

## Reconnecting

On reconnect the client sends its resume token, `lastSeq`, and keeps its client
id. The server replies with either the batches after `lastSeq` (from an
in-memory history of 10,000) or a full snapshot, plus `ackedThrough`: the
highest batch id it has processed from this client. Pending batches at or below
that id already have a final outcome (applied, and so in the catch-up, or
rejected), so the client drops them and resends the rest. The server also
deduplicates by `(clientId, batchId)`, so a resend can never apply twice.

## Durability

The room applies batches in memory immediately, but every message whose meaning
depends on document order — welcome, ack, reject, broadcast — waits in one queue
until the batches before it are committed to Postgres. Group commit (one insert
per ~5 ms) keeps throughput high. So:

- an acked change is durable;
- nobody ever sees a change that a crash could lose;
- each connection sees messages in seq order.

If a commit fails, the room is reset: everyone is disconnected, the room reloads
from storage, and clients resend their unacknowledged batches.

## Undo

Undo is local and per-user. Each step records inverse ops computed against the
display state when the edit was made (`set` restores the old value, `create`
becomes `delete`, and `delete` recreates the whole subtree with its original
ids). Undoing applies the inverse as a new batch that syncs like any edit, and
other people's changes never enter your history. Inverses that target nodes
someone else has since deleted are dropped.

## Alternatives considered

|                         | Server-ordered LWW (chosen)           | Operational transform             | CRDT (e.g. Yjs)                              |
| ----------------------- | ------------------------------------- | --------------------------------- | -------------------------------------------- |
| Conflict model          | per property, last write wins         | transform concurrent ops pairwise | merge any order, commutative by construction |
| Needs a server to order | yes                                   | usually                           | no (peer-to-peer possible)                   |
| Offline edits           | queue and resend; merge at the server | hard                              | merge anywhere                               |
| Metadata                | none per property                     | op history                        | tombstones and per-item ids                  |
| Fit for a design canvas | good: properties are independent      | poor: built for text              | good, but heavier and harder to inspect      |

Figma's published design reaches the same conclusion: a canvas is mostly
independent properties, so the full generality of OT or CRDTs is not needed, and
a central server is required anyway for access control and persistence.

## Differences from Figma's published approach

- **Same:** server-authoritative ordering, per-property LWW, fractional indexing
  for order, client-generated ids, and the rule that a client keeps showing its
  own unacknowledged value.
- **Different:** Murmuration's client keeps a full confirmed copy and replays pending
  batches, where Figma tracks unacknowledged properties individually. Replay is
  simpler to verify and cheap at this scale (one map copy per remote batch while
  edits are pending).
- **Same:** a reparent that would form a cycle is resolved on the server; Murmuration
  drops the later one, and the client's replay drops it locally too.

## Known limitations

- A rejected batch is remembered only in memory; after a server restart a resend
  of it is re-evaluated (harmless, since rejection is for malformed data).
- Text is a single LWW property: two people typing in one text box overwrite each
  other. Character-level merging would need a text CRDT in that one property.
- One process serves each document; there is no horizontal scaling (ADR 0004).
- Pending edits live in memory, so closing the tab while offline loses them (the
  page warns first).
