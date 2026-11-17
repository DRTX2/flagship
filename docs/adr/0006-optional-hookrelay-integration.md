# ADR-0006: Publish flag changes to Hookrelay as an optional, after-commit side effect

- Status: accepted

## Context
Teams want flag changes to reach external systems (chat notifications, CI, audit warehouses). Hookrelay already solves reliable delivery (signatures, retries, DLQ, replay), so Flagship shouldn't rebuild it. But Flagship's core promise (SDKs get changes in milliseconds, even if other things are down) must not depend on another product.

## Decision
- After each committed change, publish `flag.created | flag.updated | flag.archived` to Hookrelay's ingestion API.
- Off unless `HOOKRELAY_URL` and `HOOKRELAY_API_KEY` are set.
- Fire-and-forget, 3 s timeout, failures logged and counted, never thrown.
- Idempotency key `flagship:<type>:<flag>:<env>:<version>`, so retries and duplicates are harmless.

## Alternatives
- **Transactional outbox in Flagship** (store events in a table, relay them): guarantees eventual publish even if Hookrelay is down for hours. More robust, more moving parts. It's the upgrade path if notifications become business-critical (ROADMAP).
- **Hookrelay pulling from Flagship**: couples Hookrelay to Flagship's schema. Rejected.

## Consequences
- The products stay independently deployable. Either can be down without breaking the other's core function.
- Notifications sent while Hookrelay is unreachable are lost (visible in `flagship_hookrelay_notifications_total{result="error"}`). That's acceptable for notifications; use the outbox if it stops being acceptable.
