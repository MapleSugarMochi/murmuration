# How this was built with AI tools

Tandem was built with Claude Code as a pair programmer, from a written
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

## Practices that worked

- Write the invariants first (`assertInvariants`), then check them after every
  simulated action.
- Keep protocol logic I/O-free (`packages/room`) so the same code runs in the
  server and in the simulator.
- Treat every AI-written claim about performance as unverified until
  `docs/benchmarks.md` has a measured number.
