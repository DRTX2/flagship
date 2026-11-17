# ADR-0004: Optimistic concurrency on flag configs

- Status: accepted

## Context
Two people editing the same production flag is common during incidents ("kill it!" while someone is still tuning a rule). Last-write-wins silently discards the kill switch.

## Decision
Each `(flag, environment)` config has a `version`. Writes send the version they started from. The server locks the row (`SELECT … FOR UPDATE`), compares, and returns `409 Conflict` on mismatch. Successful writes increment the version, which SDKs also use to drop out-of-order patches.

## Consequences
- No lost updates. The dashboard shows a clear "changed by someone else" message (covered by Playwright).
- Users sometimes have to re-apply an edit. That's the right trade-off for a control plane.
