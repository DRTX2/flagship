# Project context (memory)

Read this first when resuming. It records why things are the way they are, what's verified, and the traps already hit. Append to the log at the bottom.

## Summary
Feature flags with local evaluation: a pure engine (`packages/core`) shared by a streaming server SDK (`packages/sdk`) and the NestJS API's explain endpoint. Changes commit with `pg_notify` and fan out to every replica's SSE clients. The Angular 22 dashboard is served by the API. Postgres is the only stateful dependency.

## Current state (2026-11-16)
| Area | State |
|---|---|
| Features | v1 complete (IMPLEMENTATION_PLAN phases 1–3) |
| Tests | engine 64 (100% lines), SDK 9 (100%), integration 7 (2 replicas), Playwright 4, all green |
| Scans | Trivy fs + image clean (3 accepted risks), actionlint clean, ESLint clean |
| Load | 2,000 streams/replica, change to all in ≤62 ms |
| CI/CD | written, not yet run on GitHub |
| AWS | Terraform validates, never applied |

## Decisions (read the ADR before undoing)
1. Local evaluation in SDKs ([0001](adr/0001-local-evaluation.md)).
2. LISTEN/NOTIFY instead of Redis ([0002](adr/0002-postgres-listen-notify.md)).
3. MurmurHash3 + per-flag salt + ordered weights ([0003](adr/0003-murmur3-bucketing.md)). Never reorder rollout entries or change salts implicitly.
4. Optimistic concurrency ([0004](adr/0004-optimistic-concurrency.md)).
5. One service serves the dashboard ([0005](adr/0005-single-service-ecs.md)).

## Gotchas already hit
- **Nest 12 is ESM-only** → `.js` import suffixes, TypeScript pinned `~5.9` in the API (decorator metadata). The dashboard uses Angular's own TypeScript.
- **`res.sendFile` needs absolute paths**: deep links broke when `DASHBOARD_DIR` was relative. Fixed with `resolve()`, and the Playwright conflict test is what found it.
- **Playwright starts `webServer` before `globalSetup`**, so the E2E database is created in `e2e/start-server.mjs`.
- **CSP**: `script-src 'self'` works with the Angular 22 build. Styles need `'unsafe-inline'` (runtime component styles).
- **TS DOM types**: `TextDecoderStream` doesn't type-check with `pipeThrough`, so the SDK uses `TextDecoder` with `stream: true` and normalizes CRLF on the whole buffer.
- **Docker**: the API's devDependency on `@flagship/sdk` requires copying `packages/sdk/package.json` in the Dockerfile for workspace resolution (not shipped in the image).
- **Base image CVEs** live in the bundled npm. The runtime stage removes npm/corepack/yarn.
- **Connection budget**: (10 pool + 1 LISTEN) × replicas must stay under RDS `max_connections`.

## Where to look
| Task | Files |
|---|---|
| New operator / evaluation rule | `packages/core/src/index.ts` (+ `OPS`, `validateFlag`) → tests → dashboard `api.ts` `OPS` + labels in `flag-detail.ts` |
| New management endpoint | `apps/api/src/admin.controller.ts` (zod) → `flags.service.ts` (transaction + audit + notify) → integration test |
| SDK behaviour | `packages/sdk/src/index.ts` → `test/sdk.test.ts` (real SSE server) |
| UI flow | `apps/dashboard/src/app/pages/*` → `e2e/tests/dashboard.spec.ts` |
| Infra | `infra/terraform/*.tf` → `terraform fmt && terraform validate` → Trivy |

## Commands
```bash
docker run -d --name flagship-pg -e POSTGRES_USER=flagship -e POSTGRES_PASSWORD=flagship -e POSTGRES_DB=flagship -p 5433:5432 postgres:17-alpine
pnpm i && pnpm --filter @flagship/core build && pnpm --filter @flagship/sdk build
pnpm --filter @flagship/core test:cov && pnpm --filter @flagship/sdk test:cov
pnpm --filter api lint && pnpm --filter api test:int
pnpm --filter api build && pnpm --filter dashboard build && CHROME_PATH=/usr/bin/google-chrome-stable pnpm --filter e2e test
docker build -t flagship:local . && docker compose up -d
```

## Log
- **2026-11-16**: v1 (engine, SDK, API, dashboard). Added metrics, JSON logs, CSP, integration suite on 2 replicas, Playwright E2E (found the deep-link bug), coverage gates, fan-out load test, hardened image, CI/CodeQL/deploy, Terraform, docs. Next: ROADMAP "Now".
