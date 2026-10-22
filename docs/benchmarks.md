# Benchmarks

Measured on 2026-10-21 and 2026-10-22 on one desktop machine: Intel Core
i5-14400F (10 cores), 16 GB RAM, Windows 11, Node 24.21, Chrome 156,
Postgres 16.4 in Docker Desktop. Client and server ran on the same machine, so
network latency is near zero; latencies are processing and batching cost.

## Summary

| ID    | What                                            | Target                    | Result                           |
| ----- | ----------------------------------------------- | ------------------------- | -------------------------------- |
| PF-01 | Frame interval, 10,000 shapes                   | p95 ≤ 16.7 ms             | ✅ 8.4–8.5 ms                    |
| PF-02 | Frame interval, 100,000 shapes                  | p95 ≤ 33 ms               | ✅ 16.8–25 ms                    |
| PF-03 | Hit test among 10,000 shapes                    | ≤ 0.2 ms                  | ✅ 0.004 ms                      |
| PF-04 | Open a 10,000-shape document                    | ≤ 1.5 s                   | ✅ 220 ms                        |
| PF-05 | Sync latency, 50 editors × 20 moves/s, Postgres | p50 ≤ 30 ms, p99 ≤ 100 ms | ⚠️ p50 46 ms, ✅ p99 76 ms       |
| PF-06 | Sustained writes to one document, durable       | ≥ 2,000 ops/s             | ✅ 2,208 ops/s                   |
| PF-07 | 2,000 connections across 100 documents          | ≤ 1 GB memory             | ✅ 269–305 MB                    |
| PF-08 | Upload while dragging one shape                 | ≤ 5 KB/s                  | ✅ 4.4 KB/s                      |
| SV-04 | `kill -9` mid-write, then restart               | no acknowledged loss      | ✅ 0 lost (200 acked, 216 total) |

## Rendering (PF-01 to PF-04)

`/bench?n=N&s=8&mode=M` builds a document of N shapes (rectangles, ellipses,
lines; 20% rotated; every shape a different colour), then animates for 8 s.
`mixed` zooms between everything and close-up while panning; `out` is the worst
case: every shape on screen, panning slowly. Run with `PERF=1 pnpm e2e perf`
(headless Chrome, 1280×800; frames are paced at 120 Hz, so 8.3 ms is a full-rate
frame).

| Shapes  | Mode  | Draw p50 / p95 before | Draw p50 / p95 after | Frame p95 before | Frame p95 after |
| ------- | ----- | --------------------- | -------------------- | ---------------- | --------------- |
| 10,000  | mixed | 3.1 / 7.8 ms          | 2.7 / 6.4 ms         | 16.7 ms          | **8.5 ms**      |
| 10,000  | out   | 13.0 / 15.1 ms        | 6.0 / 7.0 ms         | 25.2 ms          | **8.4 ms**      |
| 100,000 | mixed | 29.2 / 134 ms         | 12.3 / 15.2 ms       | 158 ms           | **16.8 ms**     |
| 100,000 | out   | 138 / 155 ms          | 17.8 / 19.5 ms       | 158 ms           | **25.0 ms**     |

Building the document and scene index takes 33 ms for 10,000 shapes and 274 ms
for 100,000. PF-04 opens a 10,000-shape document from the server in a fresh
browser context in **220 ms**, measured from navigation to the first frame with
everything loaded.

### What made it fast

The first version spent about 1.4 µs per shape on fixed Canvas overhead
(setting a transform, parsing a colour, building a path) and walked the tree
every frame. Three changes, each measured:

1. **Cached display list.** The scene flattens visible nodes into paint order
   once per document change; panning and zooming reuse it.
2. **Device-space fast paths.** Axis-aligned rectangles and ellipses, and all
   lines, are drawn in device pixels with no per-shape transform, and styles
   are only assigned when they change.
3. **A pixel layer for small shapes.** Shapes under 3 device pixels are written
   straight into a `Uint32Array`; shapes up to 8 pixels are rasterised by testing
   each pixel centre against their real geometry (rotation, ellipse, line width
   included). The buffer is composited in one `drawImage`. Trade-offs: no
   antialiasing below 8 px, and a small shape can show above a larger one
   painted later in the same frame.

A dead end worth recording: caching the packed pixel colour per hex string made
100,000-shape frames _slower_ (18 → 25 ms), because with 100,000 distinct
colours the bounded cache missed and evicted constantly. It was removed.

## Sync under load (PF-05 to PF-07)

`pnpm loadtest` spawns bot editors (real `SyncClient`s over WebSockets). Each
bot owns a rectangle and moves it `--rate` times a second; each move carries its
send time, so every other bot measures send → apply latency. Bots flush every
16 ms. Server limits were raised for the runs (`MAX_CONNECTIONS_PER_IP`,
`JOINS_PER_SECOND_PER_IP`, `DOCS_PER_MINUTE_PER_IP`).

| Run                                    | Moves/s | Deliveries | Latency p50 / p95 / p99 | Server memory | Mean commit |
| -------------------------------------- | ------- | ---------- | ----------------------- | ------------- | ----------- |
| PF-05: 50 bots, 1 doc, 20/s, in memory | 929     | 1,114,680  | 40 / 57 / 66 ms         | —             | —           |
| PF-05: 50 bots, 1 doc, 20/s, Postgres  | 920     | 1,232,064  | 46 / 68 / 76 ms         | —             | 3.7 ms      |
| PF-06: 40 bots, 1 doc, 30/s, Postgres  | 1,106   | 1,705,234  | 33 / 56 / 61 ms         | 267 MB        | 3.3 ms      |
| PF-07: 2,000 bots, 100 docs, 1/s, Pg   | 1,900   | 1,082,545  | 217 / 373 / 407 ms      | 269 MB        | 33 ms       |
| PF-07, bots split over 4 processes     | 1,900   | —          | 68–116 / — / 156–200 ms | 304 MB        | —           |

Every run ended with 0 rejected batches and 0 ops still pending. PF-06 committed
**2,208 ops/s** to Postgres, each acknowledged only after its commit.

- **PF-05 p50** is over target: the floor is the bots' 16 ms flush delay plus the
  5 ms group-commit delay. p99 is within target.
- **PF-07** meets its memory target with room to spare. Its latency is not a
  target, and much of it is the load generator: 2,000 clients in one Node
  process. Splitting them over four processes halves it, and in-memory storage
  gives the same numbers, so Postgres is not the bottleneck there.
- **Merged writes.** With 100 active documents, each room committed on its own,
  so ~2,500 small INSERTs per second queued for 10 pool connections (mean
  commit 93 ms). PgStore now merges pending appends from all documents into one
  INSERT with at most four in flight: mean commit 33 ms at that load, and
  unchanged for a single busy document.

**Pitfall:** with `DATABASE_URL` pointing at `localhost`, every parameterised
query took ~44 ms and PF-05's p99 rose to 243 ms. On Windows, `localhost`
resolves to IPv6 `::1` first, and Docker Desktop's IPv6 port forwarding delays
multi-packet requests (Postgres's extended query protocol). `SELECT 1` was
unaffected, which hid it. Use `127.0.0.1` locally.

## Upload bandwidth (PF-08)

The `PF-08` perf test drags a shape in the real editor for 5 s at ~50 pointer
moves per second and counts every WebSocket frame the page sends.

| Flush policy                   | Total    | Edits    | Presence |
| ------------------------------ | -------- | -------- | -------- |
| Every animation frame          | 8.4 KB/s | 7.6 KB/s | 0.8 KB/s |
| At most every 33 ms (30 Hz)    | 5.1 KB/s | 4.4 KB/s | 0.8 KB/s |
| At most every 40 ms (25 Hz) ✅ | 4.4 KB/s | 3.6 KB/s | 0.8 KB/s |

The editor now sends at most one batch per 40 ms. The first edit after a pause
still goes out immediately; during a drag, values coalesce within each window,
adding up to 40 ms of latency for collaborators.

## Crash recovery (SV-04)

`apps/server/src/crash.test.ts` runs the real server as a child process on
Postgres, writes a shape every 5 ms, and kills the process with `SIGKILL` once
200 shapes are acknowledged. It keeps editing while the server is down, then
restarts it. A fresh client must see every acknowledged shape before the writer
returns, and after the writer reconnects and resends, both must hold all shapes
with no duplicates. Result over four runs: 200–201 acknowledged before the kill,
216–218 created in total, nothing lost. Making `appendBatches` a no-op makes the
test fail with all 200 acknowledged shapes reported missing. CI runs it on
every change.

## Convergence

`pnpm sim --seeds 2000 --check` (2–8 clients, 400 random actions each, document
invariants checked after every action) converged on all 2,000 seeds in 125 s.
CI runs 500 property-based cases per change and 10,000 seeds nightly.

On 2026-10-22, [CI run 16](https://github.com/MapleSugarMochi/murmuration/actions/runs/39761378048)
ran seeds 16,000–25,999 (400 actions each, invariants checked at the end of each
run): all 10,000 converged, committing 299,889 batches in 91 s.

## Test coverage

`pnpm coverage` over the shared packages (doc-model, protocol, room,
sync-client, renderer), with every test including Postgres and crash recovery:
**93.7% of lines, 92.7% of functions, 88.0% of branches**. CI fails below 85%
lines or functions. `renderer/src/draw.ts` is excluded because Canvas drawing
needs a browser; the E2E and `/bench` runs exercise it.

## Reproduce

```bash
pnpm e2e                                   # functional E2E, prints the bench JSON
PERF=1 pnpm e2e perf                       # PF-01, -02, -04, -08
docker run -d --name murmuration-pg -e POSTGRES_USER=murmuration -e POSTGRES_PASSWORD=murmuration -p 55432:5432 postgres:16.4-alpine
PORT=8081 DATABASE_URL=postgres://murmuration:murmuration@127.0.0.1:55432/murmuration MAX_CONNECTIONS_PER_IP=5000 \
  JOINS_PER_SECOND_PER_IP=5000 DOCS_PER_MINUTE_PER_IP=6000 pnpm --filter @murmuration/server dev
pnpm loadtest --url http://localhost:8081 --clients 50 --rate 20 --seconds 15              # PF-05
pnpm loadtest --url http://localhost:8081 --clients 40 --rate 30 --seconds 20              # PF-06
pnpm loadtest --url http://localhost:8081 --clients 2000 --docs 100 --rate 1 --seconds 20  # PF-07
TEST_DATABASE_URL=postgres://murmuration:murmuration@127.0.0.1:55432/murmuration pnpm coverage            # incl. SV-04
pnpm sim --seeds 2000 --check
```
