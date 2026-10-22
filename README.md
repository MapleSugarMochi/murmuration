# Murmuration

A real-time multiplayer vector canvas. Share a link and draw together: everyone's
edits, cursors and selections appear live, edits made offline sync on reconnect,
and the sync protocol is written from scratch — no Yjs, no Liveblocks.

**Live demo: https://murmuration-xuzhou.fly.dev** — create a document, then open the
share link in a second window.

![Two people editing one document: Ada (left) draws a frame and a blue circle,
Bob (right) adds an orange rectangle and a note, and each sees the other's
cursor, selection and cursor chat live](docs/demo.gif)

<sub>Recorded by a script (`DEMO=1 pnpm e2e demo`): two browser windows driven by
Playwright against the real server.</sub>

## Highlights

- **Own sync protocol.** The server orders every change and resolves conflicts per
  property, last writer wins — the approach Figma describes for its multiplayer
  engine. Clients apply edits optimistically and reconcile on acknowledgement.
  See [docs/design.md](docs/design.md).
- **Proven convergence.** A simulator drives the real client and server code
  through random interleavings, dropped connections and server crashes, and
  checks every replica ends identical. 10,000 seeds run nightly.
- **Durable by construction.** A change is acknowledged only after it is in
  Postgres. A test hard-kills the server mid-write and checks nothing
  acknowledged is lost.
- **Fast canvas.** Canvas 2D renderer with a cached display list, device-space
  fast paths and a pixel layer for small shapes: 100,000 shapes at 60 fps while
  panning and zooming.

|             |                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shapes      | rectangle, ellipse, line, arrow, freehand, text, frame (nestable, clipping)                                                                             |
| Editing     | select, marquee, move, resize, rotate, smart snapping, align and distribute, z-order, copy/paste, duplicate, undo/redo, layers panel with drag-and-drop |
| Multiplayer | live cursors, remote selections, presence avatars, follow mode, cursor chat, view-only links, link reset                                                |
| Resilience  | offline editing with automatic resend, reconnect with catch-up, graceful restart, backpressure                                                          |
| Export      | PNG (1x, 2x), JSON export and import                                                                                                                    |

## Numbers

Measured on an Intel i5-14400F, 16 GB RAM; details and method in
[docs/benchmarks.md](docs/benchmarks.md).

| What                                                   | Result                                         |
| ------------------------------------------------------ | ---------------------------------------------- |
| Sync latency, 50 editors × 20 moves/s, Postgres-backed | p50 46 ms, p99 76 ms (acked only after commit) |
| Sustained durable writes to one document               | 2,208 ops/s                                    |
| 2,000 connections across 100 documents                 | 269 MB server memory                           |
| Frame interval, 10,000 / 100,000 shapes                | p95 8.5 ms / 16.8 ms (pan and zoom)            |
| Open a 10,000-shape document                           | 220 ms                                         |
| Upload while dragging a shape                          | 4.4 KB/s                                       |
| `kill -9` during writes                                | 0 acknowledged edits lost                      |
| Convergence simulator                                  | 10,000 random seeds, all converged             |
| Test coverage, shared packages                         | 93.7% lines                                    |

## Architecture

```
apps/web            React UI, editor state machine, overlays
apps/server         Fastify + ws; rooms, persistence, rate limits, metrics
packages/doc-model  document, ops, validation, fractional indexing (shared)
packages/protocol   message types and zod validation (shared)
packages/room       ordering, dedup, history, protocol handling — no I/O (shared by server and simulator)
packages/sync-client  optimistic client: pending queue, reconnect, undo
packages/renderer   Canvas 2D drawing, scene transforms, quadtree, hit testing
tools/sim           convergence simulator
tools/loadtest      WebSocket load generator
```

The browser keeps two copies of the document: _confirmed_ (server state) and
_display_ (confirmed plus pending local edits). The server runs one room per
document that applies batches in order, persists them in group commits, and only
then acknowledges and broadcasts.

## Run it

Requires Node 22+.

```bash
corepack enable
pnpm install
pnpm dev
```

Open http://localhost:5173. Without `DATABASE_URL`, documents live in memory. For
the full stack with Postgres:

```bash
docker compose -f deploy/docker-compose.yml up --build
```

Then open http://localhost:8080.

## Test it

```bash
pnpm test        # unit, integration and 300-seed convergence tests
pnpm sim --seeds 10000
pnpm e2e         # Playwright, two browsers collaborating
pnpm loadtest --clients 50 --rate 20 --seconds 30
```

## Docs

- [Design](docs/design.md): the sync protocol and its trade-offs
- [Protocol](docs/protocol.md): message reference and sequences
- [Benchmarks](docs/benchmarks.md)
- [Deploying](docs/deploy.md): GitHub and Fly.io, step by step
- [Threat model](docs/threat-model.md)
- [Architecture decisions](docs/adr/)
- [How this was built with AI tools](docs/ai-workflow.md)

## License

MIT
