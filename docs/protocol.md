# Protocol reference

JSON messages over one WebSocket at `/ws`, version `PROTOCOL_VERSION = 1`.
`packages/protocol` is the source of truth; both ends import it.

## Client → server

| type       | fields                                                                            | notes                      |
| ---------- | --------------------------------------------------------------------------------- | -------------------------- |
| `hello`    | `protocolVersion`, `docId`, `token`, `name`, `resume?{clientId, sig}`, `lastSeq?` | must be first, within 10 s |
| `batch`    | `batchId` (increasing per client), `ops[]` (1–500)                                | edit role only             |
| `presence` | `cursor?`, `selection?`, `viewport?`, `chat?`                                     | partial update; lossy      |
| `ping`     | `t`                                                                               | answered with `pong`       |

## Server → client

| type                       | fields                                                                                                             | notes                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `welcome`                  | `clientId`, `resumeSig`, `role`, `name`, `color`, `docName`, `seq`, `ackedThrough`, `snapshot?` or `ops?`, `peers` |                                      |
| `ack`                      | `batchId`, `seq`                                                                                                   | your batch was applied and persisted |
| `reject`                   | `batchId`, `reason`                                                                                                | your batch was malformed; drop it    |
| `ops`                      | `seq`, `clientId`, `batchId`, `ops[]`                                                                              | someone else's applied batch         |
| `presence`                 | `clientId`, `presence`                                                                                             |                                      |
| `peer-join` / `peer-leave` | `peer` / `clientId`                                                                                                |                                      |
| `doc-renamed`              | `name`                                                                                                             |                                      |
| `pong`                     | `t`                                                                                                                |                                      |
| `error`                    | `code`, `message`, `fatal`                                                                                         | fatal errors close the socket        |

Error codes: `protocol_version`, `bad_message`, `unauthorized`, `not_found`,
`read_only`, `rate_limited`, `links_rotated`, `server_shutdown`, `room_reset`,
`internal`. The client stops reconnecting after `unauthorized`, `not_found`,
`links_rotated` and `protocol_version`, and retries with backoff otherwise.

## Sequences

Joining and editing:

```
client                         server
  | hello -------------------->  |  check token → role
  |                              |  (welcome waits for earlier commits)
  | <------------------- welcome |  snapshot + seq
  | batch #1 ----------------->  |  apply → seq 8 → queue
  |                              |  group commit to Postgres
  | <---------------- ack #1 s8  |  others get ops s8
```

Reconnecting with pending edits:

```
  | hello(resume, lastSeq=8) -->  |
  | <-- welcome(ops s9..s12, ackedThrough=3)
  |   drop pending batches ≤ 3; batches in the catch-up count as acks
  | batch #4, #5 (resend) ---->   |  deduplicated by (clientId, batchId)
```

## Limits

| Limit                   | Value                                         |
| ----------------------- | --------------------------------------------- |
| message size            | 256 KB                                        |
| ops per batch           | 500 (clients split larger batches)            |
| ops per connection      | 300/s, burst 600; exceeding closes the socket |
| bytes per connection    | 1 MB/s, burst 2 MB                            |
| presence per connection | 30/s (excess dropped)                         |
| outbound buffer         | 4 MB, then the connection is closed           |
| connections per IP      | 50 (configurable)                             |
| joins per IP            | 5/s, burst 20 (configurable)                  |

Exceeding an op limit closes the connection instead of dropping the batch:
silently dropping one would desynchronise the client, while a reconnect resends
it.
