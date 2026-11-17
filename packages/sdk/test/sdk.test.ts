import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FlagConfig } from '@flagship/core';
import { FlagshipClient } from '../src/index.js';

const flag = (version: number, enabled: boolean): FlagConfig => ({
  key: 'beta', variations: [false, true], enabled, offVariation: 0, rules: [],
  fallthrough: { variation: 1 }, salt: 'x', version,
});
const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const quiet = { warn: () => {} };
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

let cleanup: (() => void)[] = [];
afterEach(() => { cleanup.forEach((fn) => fn()); cleanup = []; });

/** Minimal SSE server; returns the open responses so a test can push frames or drop connections. */
async function sseServer(onConnect: (res: ServerResponse, n: number) => void) {
  let n = 0;
  const conns: ServerResponse[] = [];
  const server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer fs_sdk_test') return res.writeHead(401).end();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    conns.push(res);
    onConnect(res, ++n);
  });
  await new Promise<void>((r) => server.listen(0, r));
  cleanup.push(() => { conns.forEach((c) => c.destroy()); server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, conns };
}

describe('FlagshipClient', () => {
  it('loads the ruleset, evaluates locally and applies patches in version order', async () => {
    const { url, conns } = await sseServer((res) => res.write(frame('put', { flags: { beta: flag(1, false) } })));
    const client = await FlagshipClient.init({ sdkKey: 'fs_sdk_test', baseUrl: url, logger: quiet });
    cleanup.push(() => client.close());
    const changes: string[] = [];
    client.onChange((k) => changes.push(k));

    expect(client.initialized).toBe(true);
    expect(client.variation('beta', { key: 'u1' }, false)).toBe(false);

    conns[0].write(frame('patch', { flag: flag(3, true) }));
    await tick();
    expect(client.variation('beta', { key: 'u1' }, false)).toBe(true);

    conns[0].write(frame('patch', { flag: flag(2, false) })); // stale: arrives after v3
    await tick();
    expect(client.variation('beta', { key: 'u1' }, false)).toBe(true);

    conns[0].write(frame('delete', { key: 'beta' }));
    await tick();
    expect(client.variation('beta', { key: 'u1' }, false)).toBe(false);
    expect(changes).toEqual(['beta', 'beta']);
  });

  it('reconnects after the stream drops and resyncs from the new put', async () => {
    const { url, conns } = await sseServer((res, n) => res.write(frame('put', { flags: { beta: flag(n, n > 1) } })));
    const client = await FlagshipClient.init({ sdkKey: 'fs_sdk_test', baseUrl: url, logger: quiet });
    cleanup.push(() => client.close());
    expect(client.variation('beta', { key: 'u' }, false)).toBe(false);

    conns[0].destroy();
    for (let i = 0; i < 40 && conns.length < 2; i++) await tick();
    await tick();
    expect(conns.length).toBe(2);
    expect(client.variation('beta', { key: 'u' }, false)).toBe(true);
  });

  it('serves bootstrap values when the server is unreachable', async () => {
    const client = await FlagshipClient.init({
      sdkKey: 'fs_sdk_test', baseUrl: 'http://127.0.0.1:1', initTimeoutMs: 100, logger: quiet,
      bootstrap: { beta: flag(1, true) },
    });
    cleanup.push(() => client.close());
    expect(client.initialized).toBe(false);
    expect(client.variation('beta', { key: 'u' }, false)).toBe(true);
    expect(client.variation('missing', { key: 'u' }, 'fallback')).toBe('fallback');
  });

  it('never returns a value of the wrong type', async () => {
    const { url } = await sseServer((res) => res.write(frame('put', { flags: { beta: flag(1, true) } })));
    const client = await FlagshipClient.init({ sdkKey: 'fs_sdk_test', baseUrl: url, logger: quiet });
    cleanup.push(() => client.close());
    expect(client.variation('beta', { key: 'u' }, 'oops')).toBe('oops');
  });

  it('stops retrying on an invalid key', async () => {
    const { url } = await sseServer(() => {});
    const client = await FlagshipClient.init({ sdkKey: 'fs_sdk_wrong', baseUrl: url, initTimeoutMs: 2000, logger: quiet });
    cleanup.push(() => client.close());
    expect(client.variation('beta', { key: 'u' }, false)).toBe(false);
  });
});

describe('FlagshipClient resilience', () => {
  it('retries after a 5xx and serves all flags once connected', async () => {
    let calls = 0;
    const server = createServer((req, res) => {
      if (++calls === 1) return res.writeHead(503).end();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame('put', { flags: { beta: flag(1, true) } }));
    });
    await new Promise<void>((r) => server.listen(0, r));
    cleanup.push(() => { server.closeAllConnections(); server.close(); });
    const client = await FlagshipClient.init({ sdkKey: 'fs_sdk_test', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, logger: quiet, initTimeoutMs: 5000 });
    cleanup.push(() => client.close());
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(client.allFlags({ key: 'u' })).toEqual({ beta: true });
  });

  it('isolates a throwing change listener from the others', async () => {
    const { url, conns } = await sseServer((res) => res.write(frame('put', { flags: {} })));
    const client = await FlagshipClient.init({ sdkKey: 'fs_sdk_test', baseUrl: url, logger: quiet });
    cleanup.push(() => client.close());
    const seen: string[] = [];
    client.onChange(() => { throw new Error('boom'); });
    const off = client.onChange((k) => seen.push(k));
    conns[0].write(frame('patch', { flag: flag(1, true) }));
    await tick();
    expect(seen).toEqual(['beta']);
    off();
    conns[0].write(frame('patch', { flag: flag(2, false) }));
    await tick();
    expect(seen).toEqual(['beta']);
  });
});

describe('SSE frame handling', () => {
  it('ignores pings, comments, unknown events and no-op updates', async () => {
    const { url, conns } = await sseServer((res) => res.write(frame('put', { flags: { beta: flag(1, true) } })));
    const client = await FlagshipClient.init({ sdkKey: 'fs_sdk_test', baseUrl: url, logger: quiet });
    cleanup.push(() => client.close());
    const seen: string[] = [];
    client.onChange((k) => seen.push(k));
    client.handleEvent('event: ping\ndata: ');
    client.handleEvent(': keep-alive comment');
    client.handleEvent(`event: mystery\ndata: ${JSON.stringify({ x: 1 })}`);
    client.handleEvent(`event: put\ndata: ${JSON.stringify({ flags: { beta: flag(1, true) } })}`); // identical ruleset
    client.handleEvent(`event: delete\ndata: ${JSON.stringify({ key: 'never-existed' })}`);
    expect(seen).toEqual([]);
    expect(client.variation('beta', { key: 'u' }, false)).toBe(true);
    void conns;
  });

  it('reconnects when the server ends the stream cleanly', async () => {
    const { url, conns } = await sseServer((res, n) => {
      res.write(frame('put', { flags: { beta: flag(n, n > 1) } }));
      if (n === 1) setTimeout(() => res.end(), 50);
    });
    const client = await FlagshipClient.init({ sdkKey: 'fs_sdk_test', baseUrl: url, logger: quiet });
    cleanup.push(() => client.close());
    for (let i = 0; i < 40 && conns.length < 2; i++) await tick();
    await tick();
    expect(client.variation('beta', { key: 'u' }, false)).toBe(true);
  });
});
