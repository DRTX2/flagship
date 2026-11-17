# Spec 001: Scheduled flag changes

- Status: ready for implementation
- Related: ROADMAP #3

## Problem
Teams want launches at a precise time ("enable for everyone Monday 09:00 Guayaquil time") or temporary changes ("50% for 2 hours, then back"). Today someone has to be online to click.

## Behaviour
- A scheduled change = target config (same shape as `PUT /envs/:env`) + `runAt` (UTC instant) + optional `note`.
- Pending schedules are listed per flag/environment and can be cancelled.
- At `runAt`, the change applies exactly once, as actor `scheduler (by <creator>)`, through the same validation, version bump, audit and NOTIFY path as a manual change.
- If the flag changed after the schedule was created, the schedule still applies (it carries a full config) but the audit entry flags it as `applied over vN`. Configurable later.
- Archived flags cancel their pending schedules.

## Contract
- `POST /api/flags/:key/envs/:env/schedules` `{ runAt, config, note? }` → 201.
- `GET …/schedules`, `DELETE …/schedules/:id`.
- Migration `002_schedules.sql`: `schedules(id, flag_id, env_id, run_at, config jsonb, note, created_by, status pending|applied|cancelled|failed, applied_at, error)` with index `(run_at) WHERE status='pending'`.

## Implementation notes
- Runner: every replica polls every 15 s with `SELECT … WHERE status='pending' AND run_at <= now() FOR UPDATE SKIP LOCKED LIMIT 20`. Multiple replicas never apply the same schedule twice, and no new infrastructure is needed.
- Reuse `FlagsService.updateConfig` internals (extract a function that takes a transaction client and skips the version check).
- UI: "Schedule" next to "Save changes", using the current draft as the config.

## Acceptance criteria
1. A schedule due in the past applies within 20 s and is audited as the scheduler (integration, with a short poll interval via env).
2. Two replicas running → applied exactly once (integration with 2 replicas).
3. Invalid configs are rejected at creation (400), not at run time.
4. A cancelled schedule never applies.
5. Connected SDKs receive the patch like any other change.
