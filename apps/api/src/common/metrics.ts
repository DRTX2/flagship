import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'flagship_' });

export const metrics = {
  sseConnections: new Gauge({
    name: 'flagship_sdk_stream_connections', help: 'Connected SDK streams per environment (this replica)',
    labelNames: ['env'] as const, registers: [registry],
  }),
  configChanges: new Counter({
    name: 'flagship_config_changes_total', help: 'Committed flag changes',
    labelNames: ['env', 'action'] as const, registers: [registry],
  }),
  pushes: new Counter({
    name: 'flagship_stream_events_total', help: 'Events pushed to SDK streams, by type (put/patch/delete)',
    labelNames: ['type'] as const, registers: [registry],
  }),
  hookrelayNotifications: new Counter({
    name: 'flagship_hookrelay_notifications_total', help: 'Delivery attempts of flag events to Hookrelay, by outcome (sent/retry/dead)',
    labelNames: ['result'] as const, registers: [registry],
  }),
  listenConnected: new Gauge({
    name: 'flagship_listen_connected', help: '1 while this replica receives flag changes from PostgreSQL (LISTEN); 0 means SDKs connected here get no updates', registers: [registry],
  }),
  outboxPending: new Gauge({
    name: 'flagship_outbox_pending', help: 'Flag events waiting to be delivered to Hookrelay', registers: [registry],
  }),
  outboxOldestSeconds: new Gauge({
    name: 'flagship_outbox_oldest_seconds', help: 'Age of the oldest undelivered flag event (alert when it keeps growing)', registers: [registry],
  }),
  httpRequests: new Histogram({
    name: 'flagship_http_request_duration_seconds', help: 'API request latency',
    labelNames: ['method', 'route', 'status'] as const, buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5], registers: [registry],
  }),
};
