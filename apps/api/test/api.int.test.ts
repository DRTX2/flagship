import { type ChildProcess, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
      hookrelayCalls.push({ auth: req.headers.authorization, idem: req.headers['idempotency-key'] as string, body: JSON.parse(body) });
      res.writeHead(202).end('{}');
    });
  });
  await new Promise<void>((r) => hookrelay.listen(0, '127.0.0.1', r));
  const hookrelayUrl = `http://127.0.0.1:${(hookrelay.address() as AddressInfo).port}`;

  const dist = join(import.meta.dirname, '../dist/main.js');
  for (const base of [A, B]) {
    // replicas start one after the other so only one runs the migrations (advisory lock makes either order safe)
    const p = spawn(process.execPath, [dist], { env: { ...process.env, DATABASE_URL, ADMIN_TOKEN: ADMIN, PORT: new URL(base).port, LOG_FORMAT: 'json', ...(base === A ? { HOOKRELAY_URL: hookrelayUrl, HOOKRELAY_API_KEY: 'hr_test' } : {}) }, stdio: ['ignore', 'ignore', 'inherit'] });
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
    expect(textA).toMatch(/flagship_config_changes_total\{env="production",action="turned on"\} 1/);
  });
});
