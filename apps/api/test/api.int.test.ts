import { type ChildProcess, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FlagshipClient } from '@flagship/sdk';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://flagship:flagship@localhost:5433/flagship_test';
if (!new URL(DATABASE_URL).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must point to a *_test database');

const ADMIN = 'integration-admin';
const A = 'http://127.0.0.1:4901'; // replica A (writes)
const B = 'http://127.0.0.1:4902'; // replica B (SDK stream)
const procs: ChildProcess[] = [];
const clients: FlagshipClient[] = [];
let sdkKey = '';
// Fake Hookrelay: replica A publishes flag changes here (optional ecosystem integration).
let hookrelay: Server;
const hookrelayCalls: { auth?: string; idem?: string; body: { eventType: string; payload: Record<string, unknown> } }[] = [];
let hookrelayDown = false; // simulate an outage: the fake answers 503 and records nothing
let hookrelayRejected = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Retries a request until it returns 2xx (the API may need a moment after a database outage). */
async function eventuallyOk<T extends { status: number }>(fn: () => Promise<T>, attempts = 50): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < attempts; i++) {
    last = await fn().catch(() => undefined);
    if (last && last.status >= 200 && last.status < 300) return last;
    await sleep(200);
  }
  throw new Error(`still failing after ${attempts} attempts: ${last?.status}`);
}
const admin = async (method: string, path: string, body?: unknown, base = A) => {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, 'x-actor': 'integration-test', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const quiet = { warn: () => {} };
const NIMBUS_SECRET = 'atalaya-shared-secret-for-tests';
/** Signs exactly like Nimbus' HTTP connector: t=<unix>,v1=hex(HMAC-SHA256(secret, "<t>.<body>")). */
const nimbusCall = async (flag: string, body: object, opts: { secret?: string; t?: number } = {}) => {
  const raw = JSON.stringify(body);
  const t = opts.t ?? Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', opts.secret ?? NIMBUS_SECRET).update(`${t}.${raw}`).digest('hex');
  const res = await fetch(`${A}/automation/nimbus/flags/${flag}/envs/production`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'nimbus-signature': `t=${t},v1=${sig}` }, body: raw,
  });
  return { status: res.status, body: await res.json() };
};

beforeAll(async () => {
  const root = new pg.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') });
  await root.connect();
  const db = new URL(DATABASE_URL).pathname.slice(1);
  await root.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await root.query(`CREATE DATABASE ${db}`);
  await root.end();

  hookrelay = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (hookrelayDown) { hookrelayRejected++; res.writeHead(503).end(); return; }
      hookrelayCalls.push({ auth: req.headers.authorization, idem: req.headers['idempotency-key'] as string, body: JSON.parse(body) });
      res.writeHead(202).end('{}');
    });
  });
  await new Promise<void>((r) => hookrelay.listen(0, '127.0.0.1', r));
  const hookrelayUrl = `http://127.0.0.1:${(hookrelay.address() as AddressInfo).port}`;

  const dist = join(import.meta.dirname, '../dist/main.js');
  for (const base of [A, B]) {
    // replicas start one after the other so only one runs the migrations (advisory lock makes either order safe)
    // The key is read from a file (Docker/ECS secrets convention); the auth assertions below prove it.
    const hookrelayKeyFile = join(tmpdir(), `flagship-hookrelay-key-${process.pid}`);
    writeFileSync(hookrelayKeyFile, 'hr_test\n');
    const p = spawn(process.execPath, [dist], { env: { ...process.env, DATABASE_URL, ADMIN_TOKEN: ADMIN, PORT: new URL(base).port, LOG_FORMAT: 'json', ...(base === A ? { HOOKRELAY_URL: hookrelayUrl, HOOKRELAY_API_KEY_FILE: hookrelayKeyFile, OUTBOX_INTERVAL_MS: '200', NIMBUS_WEBHOOK_SECRET: NIMBUS_SECRET } : {}) }, stdio: ['ignore', 'ignore', 'inherit'] });
    procs.push(p);
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/health`).then((r) => r.ok).catch(() => false)) break;
      await sleep(200);
    }
  }
});

afterAll(() => {
  clients.forEach((c) => c.close());
  procs.forEach((p) => p.kill('SIGTERM'));
  hookrelay?.close();
});

describe('Flagship (black box, two replicas)', () => {
  it('protects the management API and validates flags', async () => {
    expect((await fetch(`${A}/api/flags`)).status).toBe(401);
    expect((await admin('POST', '/api/flags', { key: 'bad', name: 'x', kind: 'boolean', variations: [true, 'x'] })).status).toBe(400);
    expect((await admin('POST', '/api/flags', { key: 'new-checkout', name: 'New checkout', kind: 'boolean', variations: [false, true] })).status).toBe(201);
    expect((await admin('POST', '/api/flags', { key: 'new-checkout', name: 'dup', kind: 'boolean', variations: [false, true] })).status).toBe(409);
  });

  it('issues SDK keys that are shown once and rejects bad keys', async () => {
    const r = await admin('POST', '/api/environments/production/sdk-key');
    sdkKey = r.body.sdkKey;
    expect(sdkKey).toMatch(/^fs_sdk_/);
    const envs = await admin('GET', '/api/environments');
    expect(envs.body.find((e: { key: string }) => e.key === 'production').sdkKeyHint).toBe(sdkKey.slice(-4));
    expect((await fetch(`${A}/sdk/v1/flags`, { headers: { authorization: 'Bearer fs_sdk_nope' } })).status).toBe(401);
  });

  it('propagates a change written on replica A to an SDK streaming from replica B in under a second', async () => {
    const client = await FlagshipClient.init({ sdkKey, baseUrl: B, logger: quiet });
    clients.push(client);
    expect(client.initialized).toBe(true);
    expect(client.variation('new-checkout', { key: 'u1', country: 'EC' }, true)).toBe(false); // off

    const flag = await admin('GET', '/api/flags/new-checkout');
    const changed = new Promise<number>((resolve) => client.onChange((k) => k === 'new-checkout' && resolve(performance.now())));
    const t0 = performance.now();
    const put = await admin('PUT', '/api/flags/new-checkout/envs/production', {
      enabled: true, offVariation: 0, version: flag.body.envs.production.version,
      rules: [{ id: 'ec', clauses: [{ attribute: 'country', op: 'in', values: ['EC'] }], serve: { variation: 1 } }],
      fallthrough: { variation: 0 },
    });
    expect(put.status).toBe(200);
    expect((await changed) - t0).toBeLessThan(1000);
    expect(client.variation('new-checkout', { key: 'u1', country: 'EC' }, false)).toBe(true);
    expect(client.variation('new-checkout', { key: 'u2', country: 'US' }, true)).toBe(false);
  });

  it('rejects stale edits (optimistic concurrency) and invalid rollouts', async () => {
    const stale = await admin('PUT', '/api/flags/new-checkout/envs/production', { enabled: false, offVariation: 0, fallthrough: { variation: 0 }, rules: [], version: 1 });
    expect(stale.status).toBe(409);
    const bad = await admin('PUT', '/api/flags/new-checkout/envs/production', {
      enabled: true, offVariation: 0, rules: [], version: 2, fallthrough: { rollout: [{ variation: 1, weight: 30000 }] },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.message.join(' ')).toMatch(/sum to 100%/);
  });

  it('explains evaluations with the production engine and keeps an audit trail', async () => {
    const ex = await admin('POST', '/api/flags/new-checkout/envs/production/explain', { context: { key: 'u1', country: 'EC' } });
    expect(ex.body).toMatchObject({ value: true, reason: { kind: 'RULE_MATCH', ruleId: 'ec' } });
    const audit = await admin('GET', '/api/flags/new-checkout/audit');
    expect(audit.body.map((a: { action: string }) => a.action)).toEqual(['turned on', 'created']);
    expect(audit.body[0].actor).toBe('integration-test');
  });

  it('rolls back to the configuration before an audit entry, through the normal write path', async () => {
    const client = clients[0];
    const audit = await admin('GET', '/api/flags/new-checkout/audit');
    const turnedOn = audit.body.find((a: { action: string }) => a.action === 'turned on');
    const changed = new Promise<void>((resolve) => client.onChange((k) => k === 'new-checkout' && resolve()));
    const r = await admin('POST', '/api/flags/new-checkout/envs/production/rollback', { auditId: turnedOn.id });
    expect(r.status).toBe(201);
    await changed;
    expect(client.variation('new-checkout', { key: 'u1', country: 'EC' }, true)).toBe(false); // back to off
    const after = await admin('GET', '/api/flags/new-checkout/audit');
    expect(after.body[0]).toMatchObject({ action: `rolled back to #${turnedOn.id}`, actor: 'integration-test' });
    expect((await admin('POST', '/api/flags/new-checkout/envs/production/rollback', { auditId: 999999 })).status).toBe(404);
  });

  it('publishes flag changes to Hookrelay with auth and an idempotency key (optional integration)', async () => {
    for (let i = 0; i < 20 && !hookrelayCalls.some((c) => c.body.eventType === 'flag.updated'); i++) await sleep(100);
    const created = hookrelayCalls.find((c) => c.body.eventType === 'flag.created');
    const updated = hookrelayCalls.find((c) => c.body.eventType === 'flag.updated' && c.body.payload.action === 'turned on');
    expect(created?.auth).toBe('Bearer hr_test');
    expect(updated?.idem).toBe('flagship:flag.updated:new-checkout:production:2');
    expect(updated?.body.payload).toMatchObject({ flagKey: 'new-checkout', env: 'production', version: 2, actor: 'integration-test' });
  });

  it('survives the database dropping every connection (failover): the process stays up and recovers', async () => {
    const before = procs.map((p) => p.exitCode);
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`);
    await admin.end();
    await sleep(500);
    expect(procs.map((p) => p.exitCode)).toEqual(before); // nobody crashed
    let status = 0;
    for (let i = 0; i < 20 && status !== 200; i++) {
      status = (await fetch(`${A}/api/flags`, { headers: { authorization: `Bearer ${ADMIN}` } }).catch(() => ({ status: 0 }))).status;
      if (status !== 200) await sleep(200);
    }
    expect(status).toBe(200);
  });

  it('keeps pushing changes to SDKs after the database refused connections for a while (failover)', async () => {
    const key = 'failover-push';
    await admin('POST', '/api/flags', { key, name: 'Failover push', kind: 'boolean', variations: [false, true] });
    const client = await FlagshipClient.init({ sdkKey, baseUrl: B, logger: quiet });
    try {
      // From the maintenance database: a database cannot refuse connections to itself.
      const owner = new pg.Client({ connectionString: DATABASE_URL.replace(/\/[^/]+$/, '/postgres') });
      await owner.connect();
      const db = new URL(DATABASE_URL).pathname.slice(1);
      // A failover: connections drop and new ones are refused for longer than one reconnect attempt.
      await owner.query(`ALTER DATABASE ${db} ALLOW_CONNECTIONS false`);
      await owner.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1`, [db]);
      await sleep(3500);
      await owner.query(`ALTER DATABASE ${db} ALLOW_CONNECTIONS true`);
      await owner.end();

      const f = await eventuallyOk(() => admin('GET', `/api/flags/${key}`));
      await eventuallyOk(() => admin('PUT', `/api/flags/${key}/envs/production`, { enabled: true, offVariation: 0, fallthrough: { variation: 1 }, rules: [], version: f.body.envs.production.version }));
      // Replica B's SDK only sees this if B re-established LISTEN after the outage.
      for (let i = 0; i < 100 && client.variation(key, { key: 'u1' }, false) !== true; i++) await sleep(100);
      expect(client.variation(key, { key: 'u1' }, false)).toBe(true);
    } finally {
      client.close();
    }
  });

  it('never loses a flag event while Hookrelay is down: the outbox retries until it is delivered exactly once', async () => {
    hookrelayDown = true;
    await admin('POST', '/api/flags', { key: 'outbox-check', name: 'Outbox check', kind: 'boolean', variations: [false, true] });
    for (let i = 0; i < 30 && hookrelayRejected === 0; i++) await sleep(100);
    expect(hookrelayRejected).toBeGreaterThan(0); // it tried and failed…
    const created = () => hookrelayCalls.filter((c) => c.idem === 'flagship:flag.created:outbox-check:all:0');
    expect(created()).toHaveLength(0);

    hookrelayDown = false; // …and once Hookrelay is back, the retry delivers it
    for (let i = 0; i < 100 && created().length === 0; i++) await sleep(100);
    expect(created()).toHaveLength(1);
    await sleep(600); // a few more dispatcher passes: still exactly one delivery
    expect(created()).toHaveLength(1);
    expect(created()[0].body.payload).toMatchObject({ flagKey: 'outbox-check', action: 'created', actor: 'integration-test' });
  });

  it('lets a signed Nimbus incident kill a flag and restore it on recovery (Atalaya integration)', async () => {
    await admin('POST', '/api/flags', { key: 'orders-v2', name: 'Orders v2', kind: 'boolean', variations: [false, true] });
    const f = await admin('GET', '/api/flags/orders-v2');
    await admin('PUT', '/api/flags/orders-v2/envs/production', { enabled: true, offVariation: 0, fallthrough: { variation: 1 }, rules: [], version: f.body.envs.production.version });
    const incident = { incidentId: 'inc-1', event: 'opened', source: 'nimbus', pipelineName: 'Orders', summary: 'Consumer stalled' };

    expect((await nimbusCall('orders-v2', incident, { secret: 'wrong-secret-xxxxxxxx' })).status).toBe(401);
    expect((await nimbusCall('orders-v2', incident, { t: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401); // replay window

    const killed = await nimbusCall('orders-v2', incident);
    expect(killed.body).toMatchObject({ changed: true, action: 'killed' });
    expect((await nimbusCall('orders-v2', incident)).body).toMatchObject({ changed: false, reason: 'already off' }); // at-least-once retry
    const audit = await admin('GET', '/api/flags/orders-v2/audit');
    expect(audit.body[0]).toMatchObject({ actor: 'nimbus (automation)', action: 'killed by nimbus incident inc-1: Consumer stalled' });

    const restored = await nimbusCall('orders-v2', { ...incident, event: 'recovered' });
    expect(restored.body).toMatchObject({ changed: true, action: 'restored' });
    expect((await admin('GET', '/api/flags/orders-v2')).body.envs.production.enabled).toBe(true);
    expect((await nimbusCall('orders-v2', { ...incident, event: 'recovered' })).body.changed).toBe(false);
  });

  it('never lets automation override a human change made during the incident', async () => {
    await nimbusCall('orders-v2', { incidentId: 'inc-2', event: 'opened' });
    const f = await admin('GET', '/api/flags/orders-v2');
    // on-call engineer adjusts the flag manually while the incident is open
    await admin('PUT', '/api/flags/orders-v2/envs/production', { ...f.body.envs.production, updatedAt: undefined, rules: [{ id: 'staff', clauses: [{ attribute: 'email', op: 'endsWith', values: ['@acme.com'] }], serve: { variation: 1 } }] });
    const r = await nimbusCall('orders-v2', { incidentId: 'inc-2', event: 'recovered' });
    expect(r.body).toMatchObject({ changed: false });
  });

  it('removes archived flags from connected SDKs', async () => {
    const client = clients[0];
    const gone = new Promise<void>((resolve) => client.onChange((k) => k === 'new-checkout' && resolve()));
    expect((await admin('DELETE', '/api/flags/new-checkout')).status).toBe(204);
    await gone;
    expect(client.variation('new-checkout', { key: 'u1', country: 'EC' }, false)).toBe(false); // fallback
  });

  it('exposes stream and change metrics', async () => {
    const text = await (await fetch(`${B}/metrics`)).text();
    expect(text).toMatch(/flagship_sdk_stream_connections\{env="production"\} 1/);
    const textA = await (await fetch(`${A}/metrics`)).text();
    expect(textA).toMatch(/flagship_config_changes_total\{env="production",action="turned on"\} [1-9]\d*/);
  });
});
