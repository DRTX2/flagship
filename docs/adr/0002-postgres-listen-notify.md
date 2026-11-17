# ADR-0002: Fan out changes with Postgres LISTEN/NOTIFY instead of Redis or a broker

- Status: accepted

## Context
Every API replica must learn about every flag change to push it to its own SSE clients. Typical choices are Redis pub/sub, Kafka/SNS, or polling.

## Decision
`pg_notify('flag_changes', {env, key})` inside the write transaction; one `LISTEN` connection per replica.

## Consequences
- **Transactional**: a notification is delivered only if the change commits. Redis pub/sub published after commit can be lost when the process crashes in between; published before commit, it can announce a rolled-back change.
- No extra infrastructure: one stateful dependency to run, back up and secure.
- Notifications are fire-and-forget and lost while a listener is disconnected. Mitigated by a full `put` resync on reconnect, plus SDKs resync on every stream reconnect.
- NOTIFY payloads are limited to 8 KB, so we send only `{env, key}` and replicas load the config.
- Limits: change *rate* is low by nature (humans edit flags), so NOTIFY throughput is never the bottleneck. Connections are the resource to watch (pool × replicas + 1 listener each).
