# Observability

## SLOs
| SLI | Objective | Signal |
|---|---|---|
| Propagation: change committed → SDK patched | p99 < 1 s | integration test asserts < 1 s; load test p99 62 ms at 2,000 streams |
| SDK API availability (`/sdk/v1/*` non-5xx) | 99.95% | `flagship_http_request_duration_seconds_count{route=~"/sdk.*"}` |
| Management API latency | p95 < 300 ms | same histogram, `/api` routes |
| At least one healthy replica | always | ALB `HealthyHostCount` alarm |

Note that a Flagship outage **doesn't** break customer apps: SDKs keep evaluating from memory. The impact is "changes don't propagate", which is why the propagation SLO matters more than raw availability.

## Logs
JSON (`ConsoleLogger`) when `NODE_ENV=production`/`LOG_FORMAT=json`. One line per `/api` and `/sdk` request with `requestId` (accepted from `x-request-id` or generated). Stream requests aren't logged at completion (their duration is connection time). Admin tokens, SDK keys and flag configs are never logged.

## Metrics (`GET /metrics`, blocked at the ALB)
| Metric | Type | Labels |
|---|---|---|
| `flagship_sdk_stream_connections` | gauge | `env` (per replica) |
| `flagship_stream_events_total` | counter | `type` = put/patch/delete |
| `flagship_config_changes_total` | counter | `env`, `action` (turned on/off, updated targeting) |
| `flagship_http_request_duration_seconds` | histogram | `method`, `route`, `status` |
| `flagship_process_*`, `flagship_nodejs_*` | default | CPU, memory, event loop lag |

Useful queries:
```promql
sum by (env) (flagship_sdk_stream_connections)                         # connected SDKs
sum(rate(flagship_stream_events_total{type="put"}[5m]))                 # resync storms (deploys, LISTEN drops)
histogram_quantile(0.95, sum by (le) (rate(flagship_http_request_duration_seconds_bucket{route!~"/sdk/v1/stream"}[5m])))
```

## Traces
Same zero-code setup as Hookrelay: `NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register` with `OTEL_*` env vars (dependency installed; disabled by default).

## Alerts
CloudWatch (`infra/terraform/alarms.tf`): ALB 5xx, no healthy hosts, CPU, RDS CPU, RDS connections. Each links to a [RUNBOOK](RUNBOOK.md) section.

## Gaps
- The metrics aren't scraped in AWS yet (Amazon Managed Prometheus / CloudWatch EMF), so the propagation SLO isn't monitored in production. The next step is a synthetic probe that flips a canary flag every minute and measures arrival through an SDK.
- No `put`-storm alert yet (useful to detect LISTEN flapping).
