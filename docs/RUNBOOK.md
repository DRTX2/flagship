# Runbook

Remember: when Flagship is degraded, customer apps **keep working** on their last known flags. The risk is that changes (including kill switches) don't propagate. Prioritize restoring propagation.

## api-errors
**ALB 5xx.** Logs Insights: `filter message.status >= 500 | stats count() by message.path`. Usual causes: database unreachable (check RDS status and connections), a bad deploy (the circuit breaker should have rolled back; otherwise redeploy the previous sha).

## no-replicas
**HealthyHostCount < 1.** SDKs are disconnected and retrying with backoff.
1. `aws ecs describe-services --cluster flagship-production --services flagship-production` → events, stopped reason.
2. Crash loop right after a deploy → secret/config issue; read the last lines in `/ecs/flagship-production/app`.
3. Once a task is healthy, SDKs reconnect within their backoff (≤30 s) and receive a full `put`.

## saturation
**CPU > 85%** despite autoscaling at max.
1. `sum(flagship_sdk_stream_connections)`: has the number of SDK instances jumped (a customer scaled out)?
2. `rate(flagship_stream_events_total{type="put"}[5m])` high → resync storm. Check for LISTEN connection flapping (logs: `LISTEN connection lost`) or repeated deploys.
3. Raise `app_max` / task size (see the connection budget in DEPLOYMENT).

## database
**RDS CPU or connections high.** Connections ≈ (pool 10 + 1 LISTEN) × replicas. Lower the pool size or scale the instance. CPU usually comes from a `put` storm (each reconnect loads the ruleset). See SCALABILITY for ruleset caching.

## A change didn't reach SDKs
1. Was it committed? The audit log shows it (`GET /api/flags/:key/audit`).
2. Check `flagship_stream_events_total{type="patch"}` increased on every replica. If one didn't, its LISTEN connection is down. It should self-heal within ~1 s; if not, restart that task (SDKs resync).
3. SDK side: check `client.initialized` and SDK warnings (`[flagship] …`). An invalid SDK key stops retrying on purpose.

## Emergency kill switch without the dashboard
```bash
TOKEN=$(aws secretsmanager get-secret-value --secret-id flagship-production/app --query SecretString --output text | jq -r .ADMIN_TOKEN)
V=$(curl -s -H "authorization: Bearer $TOKEN" https://<host>/api/flags/<key> | jq .envs.production.version)
curl -X PUT -H "authorization: Bearer $TOKEN" -H 'x-actor: oncall' -H 'content-type: application/json' \
  https://<host>/api/flags/<key>/envs/production \
  -d "{\"enabled\":false,\"offVariation\":0,\"fallthrough\":{\"variation\":0},\"rules\":[],\"version\":$V}"
```
