# 4. One instance; no horizontal scaling

Status: accepted

## Context

Server-ordered sync needs exactly one writer per document. Running several
instances would require routing each document to an owner, for example with a
Redis lease and fencing tokens.

## Decision

Deploy a single instance. Each document is loaded into one room in that
process.

## Consequences

- Much simpler operation and testing; no split-brain risk.
- Capacity is bounded by one machine; the load test shows 50 editors on one
  document at about 930 moves per second with p99 66 ms.
- If needed later: route by document id to an owner instance, with a lease
  (`SET NX PX`) and an epoch checked on every write.
