# 3. Acknowledge only after commit

Status: accepted

## Context

Acknowledging a batch before it is durable is faster, but after a crash a
client could hold an acknowledged change that the server lost, and peers could
have seen it.

## Decision

The room applies batches in memory at once, but every order-dependent message
(welcome, ack, reject, broadcast) waits in a single queue until the batches
before it are committed. Commits are grouped every few milliseconds into one
`INSERT`.

## Consequences

- An ack means durable, and nobody sees a change a crash could lose.
- Latency rises by the commit delay (5 ms) plus the database round trip.
- A failed commit resets the room; clients reconnect and resend.
