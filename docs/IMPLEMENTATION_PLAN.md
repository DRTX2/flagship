# Implementation plan

Legend: ✅ done and verified · 🟡 partial · ⬜ not started.

## Phase 1: Engine & SDK ✅
| Item | Status | Evidence |
|---|---|---|
| Evaluation engine (rules, operators, semver, rollouts, reasons) | ✅ | `packages/core`, 64 tests, 100% lines |
| MurmurHash3 bucketing (sticky, monotonic, salted) | ✅ | reference vectors + distribution tests |
| Flag validation shared by API and UI rules | ✅ | `validateFlag` |
| Server SDK: streaming, reconnect, version ordering, bootstrap, type safety | ✅ | `packages/sdk`, 9 tests on a real SSE server |

## Phase 2: Control plane ✅
| Item | Status |
|---|---|
| Management API: flags, per-env configs, archive, audit, explain | ✅ |
| Optimistic concurrency (409) | ✅ integration + E2E |
| SDK endpoints: ruleset with ETag, SSE stream | ✅ |
| LISTEN/NOTIFY fan-out across replicas + resync on reconnect | ✅ integration (2 replicas) |
| Environments + hashed SDK keys, rotation | ✅ |
| Angular dashboard: list, editor, rollout bars, explain, history, environments | ✅ Playwright |

## Phase 3: Production readiness ✅
| Item | Status |
|---|---|
| JSON logs + request ids, Prometheus metrics (streams, changes, latency) | ✅ |
| Helmet with strict CSP, body size cap | ✅ (E2E asserts no page errors under CSP) |
| Black-box integration suite (2 replicas + real SDK) | ✅ 7 tests |
| Playwright E2E suite in repo | ✅ 4 flows (also caught a real deep-link bug) |
| Fan-out load test (2,000 streams) | ✅ |
| Hardened runtime image (no npm/corepack, patched OS) | ✅ Trivy image clean |

## Phase 4: Pipeline & cloud 🟡
| Item | Status | Next step |
|---|---|---|
| CI: lint, typecheck, coverage gates, integration, E2E, build | ✅ written, actionlint clean | First push to GitHub |
| SonarQube | 🟡 | Create the project, set `SONAR_TOKEN` + `SONAR_ENABLED=true` |
| CodeQL, Trivy, gitleaks | ✅ | |
| Terraform (VPC, ECS, ALB, RDS, Secrets, alarms, OIDC) | ✅ validates | Apply in an AWS account (DEPLOYMENT) |
| Deploy workflow with approval gate | 🟡 | Run after the first apply |

## Phase 5 ⬜
See [ROADMAP](ROADMAP.md): SSO + roles, scheduled changes (spec ready), experiment exposure events, browser SDK, prerequisites, VPC endpoints.

## Definition of done
Spec for non-trivial changes (`docs/specs/`) → tests at the right level (engine rules = unit, API = integration, UI flows = Playwright) → lint, types and coverage gates pass, Trivy clean → metrics/alerts for new failure modes → docs and the CONTEXT log updated.
