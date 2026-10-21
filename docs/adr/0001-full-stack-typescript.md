# 1. Full-stack TypeScript

Status: accepted

## Context

The client and server must apply ops with exactly the same rules, or replicas
diverge. A Go server was considered, to show a second language.

## Decision

Write the server in TypeScript on Node.js, in the same pnpm monorepo as the web
app. `doc-model`, `protocol` and `room` are shared packages.

## Consequences

- One implementation of validation and op application; no cross-language
  contract tests.
- The convergence simulator runs the real server room logic in-process.
- Node is single-threaded, so one room cannot use more than one core. That fits
  the single-process-per-document model (ADR 4).
