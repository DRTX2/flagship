# ADR-0003: MurmurHash3 bucketing with a per-flag salt and ordered weights

- Status: accepted

## Context
Percentage rollouts must be sticky (the same user always gets the same variation), stateless (no assignment table), identical on every runtime, and stable when the percentage changes.

## Decision
`bucket = floor(murmur3_x86_32("flagKey.salt.value") / 2^32 × 100_000)`, where `value` defaults to `context.key` (configurable `bucketBy`, e.g. `orgId`). Variations are chosen by walking the weights in order.

## Why
- MurmurHash3 is fast, well distributed and simple to port. It's implemented in-repo (~30 lines) and verified against the canonical reference vectors, with no crypto dependency in browsers.
- The per-flag **salt** decorrelates flags, so the same 20% of users aren't always first for every feature.
- **Ordered weights** make growth monotonic: going from 20% to 50% only adds users (tested over 2,000 users).
- 100,000 buckets give 0.001% granularity.

## Consequences
Changing the salt or the order of rollout entries reshuffles users. The UI never does either. Changing the salt would be the deliberate "re-randomize" action.
