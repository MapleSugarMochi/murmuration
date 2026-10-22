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

`pnpm loadtest --clients 50 --rate 20 --seconds 15` (`MAX_CONNECTIONS_PER_IP=1000`).
Each bot owns a rectangle and moves it 20 times a second; each move carries its
send time, so every other bot measures send → apply latency. Run once with the
in-memory store and once against Postgres 16.4 in Docker Desktop.

| Metric                          | Target                 | In memory            | Postgres             |
| ------------------------------- | ---------------------- | -------------------- | -------------------- |
| Moves per second (all bots)     | 1,000                  | 929                  | 920                  |
| Deliveries measured             | —                      | 1,114,680            | 1,232,064            |
| Latency p50 / p95 / p99 / max   | p50 ≤ 30, p99 ≤ 100 ms | 40 / 57 / 66 / 82 ms | 46 / 68 / 76 / 89 ms |
| Group commit, mean              | —                      | —                    | 3.7 ms (380 commits) |
| Rejected batches                | 0                      | 0                    | 0                    |
| Ops still pending after the run | 0                      | 0                    | 0                    |
| Bots' own max event-loop lag    | —                      | 16 ms                | 14 ms                |

p99 meets its target with Postgres too: durable acknowledgements cost about
6 ms at the median. p50 is over target in both runs; the floor is the client's
batching delay (one frame, 16 ms) plus the server's group-commit delay (5 ms).
Multi-document runs (PF-07) are still to do.

**Pitfall found while measuring:** with `DATABASE_URL` pointing at `localhost`,
every parameterised query took ~44 ms and the p99 rose to 243 ms. On Windows,
`localhost` resolves to IPv6 `::1` first, and Docker Desktop's IPv6 port
forwarding delays multi-packet requests (Postgres's extended query protocol).
`SELECT 1` was unaffected, which hid it. Use `127.0.0.1` locally.

## Convergence

`pnpm sim --seeds 2000 --check` (2–8 clients, 400 random actions each, document
invariants checked after every action) converged on all 2,000 seeds in 125 s.
CI runs 500 property-based cases per change and 10,000 seeds nightly.

On 2026-10-22, [CI run 16](https://github.com/MapleSugarMochi/tandem/actions/runs/39761378048)
ran seeds 16,000–25,999 (400 actions each, invariants checked at the end of each
run): all 10,000 converged, committing 299,889 batches in 91 s.

## Reproduce

```bash
pnpm e2e                                   # prints the bench JSON
PORT=8081 MAX_CONNECTIONS_PER_IP=1000 JOINS_PER_SECOND_PER_IP=1000 pnpm --filter @tandem/server dev
pnpm loadtest --url http://localhost:8081 --clients 50 --rate 20 --seconds 15
# Postgres: start one, then add DATABASE_URL to the server command above
docker run -d --name tandem-pg -e POSTGRES_USER=tandem -e POSTGRES_PASSWORD=tandem -p 55432:5432 postgres:16.4-alpine
#   DATABASE_URL=postgres://tandem:tandem@127.0.0.1:55432/tandem
TEST_DATABASE_URL=postgres://tandem:tandem@127.0.0.1:55432/tandem pnpm vitest run apps/server/src/pg-store.test.ts
pnpm sim --seeds 2000 --check
```
