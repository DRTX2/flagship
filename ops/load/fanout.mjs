// Opens N raw SSE streams to one replica, then measures how long one flag change takes to reach all of them.
// usage: start one API (ADMIN_TOKEN=load PORT=4970, empty database), then: ulimit -n 20000 && node ops/load/fanout.mjs 2000
const N = Number(process.argv[2] ?? 2000), B = process.env.FLAGSHIP_URL ?? 'http://127.0.0.1:4970';
const H = { authorization: `Bearer ${process.env.ADMIN_TOKEN ?? 'load'}`, 'content-type': 'application/json', 'x-actor': 'load' };
const rss = async () => Number((await (await fetch(`${B}/metrics`)).text()).match(/flagship_process_resident_memory_bytes (\d+)/)[1]) / 1048576;
await fetch(`${B}/api/flags`, { method: 'POST', headers: H, body: JSON.stringify({ key: 'load-flag', name: 'Load', kind: 'boolean', variations: [false, true] }) });
const { sdkKey } = await (await fetch(`${B}/api/environments/production/sdk-key`, { method: 'POST', headers: H })).json();
const before = await rss();
let ready = 0, got = 0, t0 = 0;
const lat = [];
let resolveAll; const all = new Promise((r) => (resolveAll = r));
const open = async () => {
  const res = await fetch(`${B}/sdk/v1/stream`, { headers: { authorization: `Bearer ${sdkKey}` } });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '', seenPut = false;
  for (;;) {
    const { value, done } = await reader.read(); if (done) return;
    buf += dec.decode(value, { stream: true });
    if (!seenPut && buf.includes('event: put')) { seenPut = true; ready++; buf = ''; }
    if (buf.includes('event: patch')) { lat.push(performance.now() - t0); if (++got === N) resolveAll(); buf = ''; }
  }
};
const tOpen = performance.now();
for (let i = 0; i < N; i++) { open().catch(() => {}); if (i % 200 === 199) await new Promise((r) => setTimeout(r, 50)); }
while (ready < N) await new Promise((r) => setTimeout(r, 50));
const opened = performance.now() - tOpen;
await new Promise((r) => setTimeout(r, 1000));
const after = await rss();
const flag = await (await fetch(`${B}/api/flags/load-flag`, { headers: H })).json();
t0 = performance.now();
await fetch(`${B}/api/flags/load-flag/envs/production`, { method: 'PUT', headers: H, body: JSON.stringify({ enabled: true, offVariation: 0, fallthrough: { variation: 1 }, rules: [], version: flag.envs.production.version }) });
await all;
lat.sort((a, b) => a - b);
const p = (q) => lat[Math.floor(q * (lat.length - 1))].toFixed(1);
console.log(JSON.stringify({ streams: N, openSeconds: (opened / 1000).toFixed(1), rssBeforeMB: before.toFixed(0), rssAfterMB: after.toFixed(0), kbPerStream: (((after - before) * 1024) / N).toFixed(1), propagationMs: { p50: p(0.5), p95: p(0.95), p99: p(0.99), max: p(1) } }));
process.exit(0);
