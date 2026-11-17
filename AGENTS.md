# Instructions for AI coding agents

Read `docs/CONTEXT.md` first.

## Workflow (spec-driven)
1. Non-trivial change → spec in `docs/specs/` (from `TEMPLATE.md`) with testable acceptance criteria.
2. Put logic where it belongs: evaluation rules in `packages/core` (pure, zero dependencies, isomorphic: no Node APIs), streaming/cache behaviour in `packages/sdk`, persistence + audit + NOTIFY in `apps/api/src/flags.service.ts`.
3. Tests at the right level: engine/SDK unit tests, API integration (black box, 2 replicas), UI flows in Playwright.
4. Before done:
   ```bash
   pnpm --filter @flagship/core test:cov && pnpm --filter @flagship/sdk test:cov
   pnpm --filter api lint && pnpm --filter api typecheck && pnpm --filter api test:int
   pnpm --filter api build && pnpm --filter dashboard build && pnpm --filter e2e test
   ```
5. Update docs (ADR for trade-offs, RUNBOOK/alarms for new failure modes, the CONTEXT log).

## Invariants (never break)
- Every config write: one transaction with version check, audit row and `pg_notify`.
- Bucketing output for an existing (flag, salt, user) never changes. Changing `murmur3`/`bucket` breaks every running rollout.
- Variations are immutable after creation (rules reference them by index).
- Missing attributes never match, even negated.
- The SDK never throws from `variation()` and never returns a value of a different type than the fallback.

## Conventions
ESM with `.js` suffixes in the API and packages. zod at every HTTP boundary. Nest `Logger` only (`no-console`). Never log tokens, SDK keys or configs. Comments explain why. Shortcuts get `// shortcut: <limit>, <when to upgrade>`.
