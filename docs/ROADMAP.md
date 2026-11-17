# Roadmap (pending work, prioritized)

Effort: S < 1 day · M 1–3 days · L > 3 days.

## Now
| # | Item | Effort | Why |
|---|---|---|---|
| 1 | Push to GitHub, enable SonarCloud, watch CI go green | S | Public evidence (badges, quality gate) |
| 2 | First AWS deploy with the minimal sizing, then destroy | M | A live URL for the portfolio |
| 3 | **Scheduled changes** ("turn on Monday 09:00") | M | Spec ready: [specs/001-scheduled-changes.md](specs/001-scheduled-changes.md) |
| 4 | Automated test for LISTEN reconnect → resync (TEST_PLAN G1) | S | The resync path is a correctness promise |

## Next
| # | Item | Effort | Why |
|---|---|---|---|
| 5 | SSO (OIDC) + roles, actor from the token | L | Replaces the shared admin token. A real audit trail |
| 6 | Production change approval (four-eyes) | M | Safety for the most dangerous environment |
| 7 | Experiment exposure events (SDK emits `{flag, variation, bucket}` batches) | M | A/B analysis. The SDK already computes bucket and reason |
| 8 | Ruleset cache per environment, invalidated by NOTIFY | S | Zero-query resync storms |
| 9 | Rate limiting on `/api`, connection limits per SDK key | S | OWASP API4 |
| 10 | Synthetic propagation probe + alert | S | Monitors the main SLO in production |
| 11 | VPC interface endpoints, egress restricted to the VPC | S | Closes an accepted risk, lowers NAT cost |

## Later
| # | Item | Effort |
|---|---|---|
| 12 | Browser/edge SDK with server-side evaluation for sensitive flags | L |
| 13 | Flag prerequisites (B only if A is on) and mutually exclusive groups | M |
| 14 | Segments: reusable named audiences across flags | M |
| 15 | Stale flag detection (no evaluations for N days) via SDK usage pings | M |
| 16 | Webhooks on flag changes (could be delivered by Hookrelay) | S |
| 17 | Dashboard on S3 + CloudFront with independent releases | S |

## Out of scope
Statistical analysis engine for experiments (export to a warehouse instead). Client-side evaluation of sensitive targeting data.
