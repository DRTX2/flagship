import { readFileSync } from 'node:fs';
import { Injectable, Logger } from '@nestjs/common';
import { metrics } from './common/metrics.js';

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
 * HOOKRELAY_API_KEY_FILE names. The file is re-read on every publish, so a rotated key is picked up
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

/**
 * Optional integration with Hookrelay (same ecosystem, independent products): publishes flag
 * changes so external systems (Slack bots, CI, audit warehouses) can subscribe to them.
 * Flagship never depends on it: unset env = no-op, failures are logged and counted, never thrown,
 * and it runs after COMMIT so it can't affect the write. The Idempotency-Key makes retries safe.
 */
@Injectable()
export class HookrelayNotifier {
  private readonly log = new Logger('HookrelayNotifier');
  private readonly url = process.env.HOOKRELAY_URL;
  get enabled(): boolean {
    return Boolean(this.url && apiKey());
  }

  notify(event: FlagEvent): void {
    const key = apiKey();
    if (!this.url || !key) return;
    const idem = ['flagship', event.type, event.flagKey, event.env ?? 'all', event.version ?? 0].join(':');
    fetch(`${this.url}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'idempotency-key': idem },
      body: JSON.stringify({ eventType: event.type, payload: { ...event, at: new Date().toISOString() } }),
      signal: AbortSignal.timeout(3000),
    })
      .then((res) => {
        metrics.hookrelayNotifications.inc({ result: res.ok ? 'sent' : 'rejected' });
        if (!res.ok) this.log.warn(`Hookrelay rejected ${event.type} for ${event.flagKey}: HTTP ${res.status}`);
      })
      .catch((e: Error) => {
        metrics.hookrelayNotifications.inc({ result: 'error' });
        this.log.warn(`Hookrelay unreachable for ${event.type} ${event.flagKey}: ${e.message}`);
      });
  }
}
