# Scalability

## Measured (laptop: i7-13650HX, 20 threads, 15 GB; Postgres 17 in Docker)
| Test | Result |
|---|---|
| Local evaluation, 10,000 users, rule + 20% rollout | 11.4 ms total (≈1.1 µs/eval) |
| Change → SDK, same replica (incl. PUT round trip) | 11.7 ms |
| Change on replica A → SDK on replica B | 13.4 ms |
| **2,000 concurrent SDK streams on one replica** | opened in 1.6 s; RSS 120 → 277 MB (**≈80 KB/stream**); one change reached all 2,000 in p50 51 ms / p99 62 ms / max 62 ms |

Method: [`ops/load/fanout.mjs`](../ops/load/fanout.mjs) (raw `fetch` streams, one replica, one flag flipped once).

## What limits a replica
1. **Memory per stream (~80 KB)**: a 1 GB task holds roughly 8–10k streams with headroom. Raise memory or add replicas.
2. **Fan-out CPU**: one patch is serialized per stream. 2,000 streams took ~60 ms, so ~10k streams per replica stays well under 1 s.
3. **File descriptors**: one per stream. Fargate's default `nofile` is 65,535.
4. **Database connections**: each replica = pool (≤10) + 1 LISTEN. The SDK API reads Postgres only on connect (`put`) and once per change per replica, **not** per evaluation. That's why SDK count doesn't load the database.

## What changes at scale
| Scale | Changes |
|---|---|
| ≤ 10k SDKs | As deployed (2–6 replicas, CPU autoscaling) |
| ~50k SDKs | Scale on connections (`flagship_sdk_stream_connections` → custom metric), bigger tasks, RDS Proxy |
| Reconnect storms (deploys) | Already mitigated: jittered SDK backoff and ETag on `GET /sdk/v1/flags`. Next: cache the ruleset per environment in memory (invalidate on NOTIFY) so a storm of `put`s costs zero queries |
| Global | Read replicas per region serving SDK streams. Changes still commit in the primary and NOTIFY doesn't cross replicas, so add a regional relay or poll the replica WAL position |

## Evaluation cost
Constant in the number of SDKs (it happens in customer processes) and linear in rules per flag. A flag with 100 rules × 20 clauses is still microseconds.
