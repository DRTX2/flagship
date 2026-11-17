# Test plan

```
         ┌──────────┐  Playwright (4): real API + built Angular app in Chromium
         │   E2E    │
       ┌─┴──────────┴─┐  Integration (7): 2 API replicas from dist/, real SDK, Postgres
       │ integration  │
     ┌─┴──────────────┴─┐  Unit: engine (64) + SDK against a real SSE server (9)
     │       unit       │
     └──────────────────┘
   + load: 2,000-stream fan-out (docs/SCALABILITY.md) · static: ESLint, tsc, CodeQL, Trivy, gitleaks, Sonar
```

## Run
| Level | Command | Needs |
|---|---|---|
| Engine | `pnpm --filter @flagship/core test:cov` | — |
| SDK | `pnpm --filter @flagship/sdk test:cov` | — |
| Integration | `pnpm --filter api test:int` | Postgres on :5433 (refuses unless the db name ends in `_test`) |
| E2E | `pnpm --filter e2e test` (local Chrome: `CHROME_PATH=/usr/bin/google-chrome-stable`) | Postgres on :5433, built api + dashboard |

## Coverage policy
Gates: **≥90% lines / ≥85% branches** on `packages/core` and `packages/sdk` (current 100/98 and 100/96). The API and dashboard are tested black-box (integration + E2E) and excluded from the % in Sonar.

## Cases
### Engine
MurmurHash3 reference vectors · stickiness · 25/75 split over 10k users within ±2% · monotonic growth · salt independence · `bucketBy` · every operator incl. boundaries and type mismatches · semver (prefix `v`, partial versions, invalid) · negation and missing attributes · array attributes · rule ordering and reasons · OFF/fallback/malformed · rollout weights not summing to 100% · every validation rule.

### SDK
Ruleset load + local evaluation · patches applied by version, stale patch ignored · delete · reconnect after a dropped and a cleanly closed stream · retry after 5xx · bootstrap when offline · wrong-type fallback · revoked key stops retrying · listener isolation · ping/comment/unknown frames ignored · no-op `put` emits nothing.

### Integration (black box)
| # | Scenario |
|---|---|
| I1 | Admin auth, flag validation (mixed types → 400), duplicate key → 409 |
| I2 | SDK key shown once, hint stored, bad key → 401 |
| I3 | **Write on replica A reaches an SDK streaming from replica B in < 1 s** and evaluation changes |
| I4 | Stale version → 409. Rollout not summing to 100% → 400 with a clear message |
| I5 | Explain = RULE_MATCH. Audit lists actor and actions in order |
| I6 | Archive → connected SDK drops the flag, fallback served |
| I7 | Metrics: open streams per env, committed changes by action |

### E2E (Playwright)
Wrong token rejected · create flag → rule + 70/30 rollout → save → history → explain (and no page errors under CSP) · conflict when a teammate saved first · SDK key shown exactly once.

## Gaps
| ID | Gap | Plan |
|---|---|---|
| G1 | LISTEN reconnect → `put` resync isn't automated | Integration: terminate the listener backend with `pg_terminate_backend`, assert the SDK receives a `put` |
| G2 | Integration/E2E coverage not measured | `NODE_V8_COVERAGE` on the spawned API + merge |
| G3 | No accessibility checks | `@axe-core/playwright` on the main pages |
| G4 | No cross-language bucketing contract | Publish bucketing test vectors as JSON so other SDKs can verify against them |
