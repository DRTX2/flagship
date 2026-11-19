# ADR-0007: Transactional outbox for Hookrelay events

**Status:** accepted · 2026-11-18 · supersedes the delivery part of [ADR-0006](0006-optional-hookrelay-integration.md)

## Context
ADR-0006 published flag events to Hookrelay fire-and-forget after COMMIT (one attempt, 3 s timeout). The Atalaya `publish-path-down` game day cut the Flagship → Hookrelay link for 10 s around an automatic kill switch: the change committed, the event was lost, and Bitácora's postmortem reported that nothing was mitigated. Any consumer of `flag.*` (audit, Slack, Bitácora) silently diverges from Flagship after a short network blip.

## Decision
- Write the event to `event_outbox` **in the same transaction** as the flag change (`HookrelayNotifier.enqueue`). Committed change ⇔ event exists.
- A dispatcher on every replica runs each second: it claims due rows with `FOR UPDATE SKIP LOCKED` and a 30 s lease, sends them in id order, marks them sent, or reschedules with exponential backoff (2 s doubling, capped at 1 h).
- After 25 failed attempts a row is parked (`dead_at`) so a request Hookrelay will always reject cannot block the queue.
- Delivery is at-least-once; the existing idempotency key (`flagship:<type>:<flag>:<env>:<version>`) makes the effect exactly-once in Hookrelay.
- `flagship_outbox_pending` and `flagship_outbox_oldest_seconds` expose the backlog; alert when the oldest age keeps growing.

## Consequences
- No lost flag events across Hookrelay outages, restarts or Flagship crashes after COMMIT. Verified by an integration test (event held during a simulated outage, delivered exactly once afterwards) and by the game day, which now passes.
- One extra insert per flag change, inside a transaction that already writes the config and the audit log.
- Sent rows accumulate; a periodic cleanup (e.g. delete rows sent more than 30 days ago) is the next step when volume matters.
- Still optional: with `HOOKRELAY_URL` unset nothing is enqueued.
