# ADR-0001: Evaluate flags locally in the SDK

- Status: accepted

## Context
Remote evaluation (`GET /evaluate?flag&user` per check) adds a network hop to every request in every customer service, and turns a flag-service outage into an application outage.

## Decision
SDKs download the full ruleset for one environment and evaluate in-process with `@flagship/core`. Updates arrive over a stream. The same engine powers the server-side "explain" endpoint.

## Consequences
- ~1 µs evaluations, and services keep working (on the last known rules or bootstrap values) when Flagship is down.
- The ruleset, including targeting values, is visible to the SDK holder. That's fine for **server-side** SDKs with secret keys. A browser SDK would need server-evaluated payloads or a client key limited to non-sensitive flags (ROADMAP).
- Memory grows with flags × rules per SDK. That's negligible at realistic sizes (hundreds of flags).
