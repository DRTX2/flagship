import { context, propagation, ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import { readFileSync } from 'node:fs';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type pg from 'pg';
import { metrics } from './common/metrics.js';
import { PG, type Db } from './db/db.js';

export interface FlagEvent {
  type: 'flag.created' | 'flag.updated' | 'flag.archived';
  flagKey: string;
  env?: string;
  version?: number;
  action: string;
  actor: string;
}

/**
 * The key, from HOOKRELAY_API_KEY or, following the Docker/ECS secrets convention, from the file
 * HOOKRELAY_API_KEY_FILE names. The file is re-read on every send, so a rotated key is picked up
 * without a restart (it's a few bytes, and flag changes are rare).
 */
function apiKey(): string | undefined {
  if (process.env.HOOKRELAY_API_KEY) return process.env.HOOKRELAY_API_KEY;
  const file = process.env.HOOKRELAY_API_KEY_FILE;
  if (!file) return undefined;
  try {
    return readFileSync(file, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

const BATCH = 20;
const LEASE_SECONDS = 30; //   a claimed row is invisible to other replicas while it's being sent
const MAX_ATTEMPTS = 25; //    ~1 day of retries at the 1 h cap, then the row is parked as dead
const backoffSeconds = (attempt: number) => Math.min(3600, 2 ** attempt); // 2 s, 4 s, 8 s … capped at 1 h

/**
 * Optional integration with Hookrelay (same ecosystem, independent products): publishes flag changes
 * so external systems (Bitácora, Slack bots, CI) can subscribe to them.
 *
 * Transactional outbox: `enqueue` writes the event in the caller's transaction, so a committed flag
 * change always has its event and a rolled-back one never does. A dispatcher on every replica claims
 * due rows (FOR UPDATE SKIP LOCKED + a lease), sends them with retries and exponential backoff, and
 * marks them sent. At-least-once delivery; the idempotency key makes the effect exactly-once in Hookrelay.
 * Flagship never depends on it: unset HOOKRELAY_URL = nothing is enqueued, and sending never blocks a write.
 */
const tracer = trace.getTracer('flagship.outbox');
type OutboxRow = { id: string; event_type: string; payload: unknown; idempotency_key: string; attempts: number; trace_context: Record<string, string> | null };

@Injectable()
export class HookrelayNotifier implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('HookrelayNotifier');
  private readonly url = process.env.HOOKRELAY_URL;
  private readonly intervalMs = Number(process.env.OUTBOX_INTERVAL_MS ?? 1000);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(@Inject(PG) private readonly db: Db) {}

  get enabled(): boolean {
    return Boolean(this.url && apiKey());
  }

  /** Call inside the transaction that makes the change. No-op when the integration is off. */
  async enqueue(c: pg.PoolClient, event: FlagEvent): Promise<void> {
    if (!this.url) return;
    const key = ['flagship', event.type, event.flagKey, event.env ?? 'all', event.version ?? 0].join(':');
    const traceContext: Record<string, string> = {};
    propagation.inject(context.active(), traceContext); // no-op when tracing is off
    await c.query(
      `INSERT INTO event_outbox (event_type, payload, idempotency_key, trace_context) VALUES ($1, $2, $3, $4) ON CONFLICT (idempotency_key) DO NOTHING`,
      [event.type, { ...event, at: new Date().toISOString() }, key, Object.keys(traceContext).length ? traceContext : null],
    );
  }

  onModuleInit() {
    if (!this.url) return;
    this.timer = setInterval(() => void this.dispatch(), this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** One pass: claim due rows, send them in order, record the outcome of each. */
  async dispatch(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { rows } = await this.db.query(
        `UPDATE event_outbox SET next_attempt_at = now() + make_interval(secs => $2)
          WHERE id IN (SELECT id FROM event_outbox
                        WHERE sent_at IS NULL AND dead_at IS NULL AND next_attempt_at <= now()
                        ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
          RETURNING id, event_type, payload, idempotency_key, attempts, trace_context`,
        [BATCH, LEASE_SECONDS],
      );
      for (const row of rows.sort((a, b) => Number(a.id) - Number(b.id))) await this.send(row);
      await this.observeBacklog();
    } catch (e) {
      this.log.warn(`outbox dispatch failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Publishes inside the trace of the change that queued the event (the outbox delay shows up as a gap). */
  private send(row: OutboxRow): Promise<void> {
    const parent = propagation.extract(ROOT_CONTEXT, row.trace_context ?? {});
    return context.with(parent, () => tracer.startActiveSpan('flagship.outbox.publish', { kind: SpanKind.PRODUCER, attributes: { 'flagship.event_type': row.event_type, 'flagship.attempt': row.attempts + 1 } }, async (span) => {
      try {
        await this.publish(row);
      } finally {
        span.end();
      }
    }));
  }

  private async publish(row: OutboxRow) {
    const key = apiKey();
    let error: string | undefined;
    if (!key) error = 'no Hookrelay API key configured';
    else {
      try {
        const res = await fetch(`${this.url}/v1/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': row.idempotency_key },
          body: JSON.stringify({ eventType: row.event_type, payload: row.payload }),
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) error = `HTTP ${res.status}`;
      } catch (e) {
        error = (e as Error).message;
      }
    }
    if (!error) {
      await this.db.query('UPDATE event_outbox SET sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1', [row.id]);
      metrics.hookrelayNotifications.inc({ result: 'sent' });
      return;
    }
    const attempt = row.attempts + 1;
    const dead = attempt >= MAX_ATTEMPTS;
    await this.db.query(
      `UPDATE event_outbox SET attempts = $2, last_error = $3,
              next_attempt_at = now() + make_interval(secs => $4), dead_at = CASE WHEN $5 THEN now() END
        WHERE id = $1`,
      [row.id, attempt, error, backoffSeconds(attempt), dead],
    );
    metrics.hookrelayNotifications.inc({ result: dead ? 'dead' : 'retry' });
    this.log.warn(`${row.event_type} (${row.idempotency_key}) not delivered to Hookrelay: ${error}; ${dead ? 'giving up' : `attempt ${attempt}, retrying in ${backoffSeconds(attempt)} s`}`);
  }

  /** Backlog size and age: the signal that matters for an outbox (alert when it grows). */
  private async observeBacklog() {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS pending, COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float AS oldest
         FROM event_outbox WHERE sent_at IS NULL AND dead_at IS NULL`,
    );
    metrics.outboxPending.set(rows[0].pending);
    metrics.outboxOldestSeconds.set(rows[0].oldest);
  }
}
