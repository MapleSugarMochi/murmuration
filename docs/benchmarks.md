# Benchmarks

All numbers below were measured on 2026-10-21 on one desktop machine:
Intel Core i5-14400F, 16 GB RAM, Windows 11, Node 24.21, Chrome 156. Client and
server ran on the same machine, so network latency is near zero; the latencies
are processing and batching cost.

## Rendering (PF-01 to PF-04)

`/bench?n=10000&s=8` builds a document of 10,000 shapes (rectangles, ellipses,
lines, 20% rotated), then pans and zooms continuously for 8 seconds, from
everything on screen to close-up. Run via `pnpm e2e` (headless Chrome, 1280×800).

| Metric                               | Target        | Result               |
| ------------------------------------ | ------------- | -------------------- |
| Draw time per frame, p50 / p95 / p99 | —             | 4.6 / 13.7 / 18.6 ms |
| Frame interval, p50 / p95 / p99      | p95 ≤ 16.7 ms | 8.4 / 25.0 / 33.4 ms |
| Hit test, average of 20,000 probes   | ≤ 0.2 ms      | 0.005 ms             |
| Build document + scene index         | —             | 46 ms                |

The frame-interval p95 misses the 60 fps target. The slow frames come from
the fully zoomed-out state, where all 10,000 shapes are on screen at once;
draw time is the bottleneck there. Next steps: batch same-coloured shapes into
one path, and raise the level-of-detail threshold.

## Sync under load (PF-05 to PF-07)

`pnpm loadtest --clients 50 --rate 20 --seconds 15` against an in-memory
server (`MAX_CONNECTIONS_PER_IP=1000`). Each bot owns a rectangle and moves it
20 times a second; each move carries its send time, so every other bot
measures send → apply latency.

| Metric                          | Target                 | Result               |
| ------------------------------- | ---------------------- | -------------------- |
| Moves per second (all bots)     | 1,000                  | 929                  |
| Deliveries measured             | —                      | 1,114,680            |
| Latency p50 / p95 / p99 / max   | p50 ≤ 30, p99 ≤ 100 ms | 40 / 57 / 66 / 82 ms |
| Rejected batches                | 0                      | 0                    |
| Ops still pending after the run | 0                      | 0                    |
| Bots' own max event-loop lag    | —                      | 16 ms                |

p99 meets its target; p50 is 10 ms over. The floor is the client's batching
delay (one frame, 16 ms) plus the server's group-commit delay (5 ms).
Postgres-backed runs and multi-document runs (PF-07) are still to do.

## Convergence

`pnpm sim --seeds 2000 --check` (2–8 clients, 400 random actions each, document
invariants checked after every action) converged on all 2,000 seeds in 125 s.
CI runs 500 property-based cases per change and 10,000 seeds nightly.

## Reproduce

```bash
pnpm e2e                                   # prints the bench JSON
PORT=8081 MAX_CONNECTIONS_PER_IP=1000 JOINS_PER_SECOND_PER_IP=1000 pnpm --filter @tandem/server dev
pnpm loadtest --url http://localhost:8081 --clients 50 --rate 20 --seconds 15
pnpm sim --seeds 2000 --check
```
