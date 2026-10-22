# How this was built with AI tools

Murmuration was built with Claude Code as a pair programmer, from a written
requirements document with numbered requirements (ED-, CO-, SY-, SV-, PF-, SE-).
This page records honestly what that looked like.

## Division of work

- **Mine:** the requirements, the choice of sync model and its trade-offs,
  reviewing every change, deciding what counts as done, and running the app.
- **AI-assisted:** first drafts of most modules, tests, and documentation,
  produced against the requirements document.
- **Verified by tooling, not trust:** convergence is checked by the simulator,
  not by reading code. The protocol is the riskiest part, so the simulator was
  built before the UI.

## What the checks caught

<!-- Keep this list up to date; it is the most useful part of this page. -->

- **Mutation check of the simulator.** Deliberately breaking the client (not
  applying remote ops to the display copy) made the simulator fail on its first
  case. This confirmed the test can detect divergence before it was trusted.
- **Rate limits desyncing clients.** A first draft dropped batches that exceeded
  the rate limit. On review, a dropped batch would leave the client waiting for
  an ack forever, and `ackedThrough` would later make it silently discard the
  edit. Fixed by closing the connection, so the client reconnects and resends.
- **Welcome ordering.** Building the peer list when a client joined, not when its
  welcome was sent, meant two people joining at the same moment never saw each
  other. Fixed by filling the list at dispatch.
- **Text box closing itself.** Found while clicking through the app: the
  canvas's default mousedown moved focus away from the new text editor, which
  then committed empty and deleted itself. Fixed by preventing the default on
  pointer-down; an E2E test now types into a new text box.
- **Strict CSP vs. test tooling.** Playwright's `waitForFunction` needs `eval`,
  which the CSP blocks — the test changed, not the CSP.

- **A 40 ms mystery in the Postgres load test.** Group commits averaged 47 ms
  although a durable insert takes 0.6 ms. Timing queries from Node showed
  parameterised queries via `localhost` took 44 ms but 0.5 ms via `127.0.0.1`:
  `localhost` went over IPv6 through Docker Desktop's port forwarding. Switching
  the address took p99 from 243 ms to 76 ms; no code change was needed.

- **An "optimisation" that made things slower.** A cache for packed pixel
  colours turned the 100,000-shape frame from 18 ms into 25 ms: with 100,000
  distinct colours a bounded cache only misses and evicts. Measuring each change
  separately caught it; the cache was removed.
- **Blaming the wrong layer.** 2,000 connections across 100 documents showed
  ~220 ms latency. Halving the message rate changed nothing, an in-memory server
  gave the same numbers, and splitting the load generator over four processes
  halved it: the bottleneck was mostly the test harness, not the server. The
  run did expose real pool contention (mean commit 93 ms), fixed by merging
  appends across documents into one INSERT (33 ms).
- **A test that proves it can fail.** The `kill -9` crash test was checked by
  turning database writes into a no-op; it then reported all 200 acknowledged
  shapes missing.

## Practices that worked

- Write the invariants first (`assertInvariants`), then check them after every
  simulated action.
- Keep protocol logic I/O-free (`packages/room`) so the same code runs in the
  server and in the simulator.
- Treat every AI-written claim about performance as unverified until
  `docs/benchmarks.md` has a measured number.
