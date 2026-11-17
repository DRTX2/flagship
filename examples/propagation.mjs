// Measures how long a flag change takes to reach a connected SDK, and shows local evaluation.
// usage: FLAGSHIP_URL=http://localhost:4000 SDK_KEY=fs_sdk_... ADMIN_TOKEN=... node propagation.mjs
import { FlagshipClient } from '@flagship/sdk';

const { FLAGSHIP_URL = 'http://localhost:4000', SDK_KEY, ADMIN_TOKEN } = process.env;
const client = await FlagshipClient.init({ sdkKey: SDK_KEY, baseUrl: FLAGSHIP_URL });

const users = Array.from({ length: 10_000 }, (_, i) => ({ key: `user-${i}`, country: i % 4 ? 'US' : 'EC' }));
const count = () => users.filter((u) => client.variation('new-checkout', u, false)).length;
console.log('before:', count(), 'of 10000 users see new-checkout');

const admin = (path, init) => fetch(FLAGSHIP_URL + path, {
  ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json', 'x-actor': 'propagation-script' },
}).then((r) => r.json());

const { envs } = await admin('/api/flags/new-checkout');
const changed = new Promise((resolve) => client.onChange((k) => k === 'new-checkout' && resolve(performance.now())));
const t0 = performance.now();
await admin('/api/flags/new-checkout/envs/production', {
  method: 'PUT',
  body: JSON.stringify({
    enabled: true, offVariation: 0, version: envs.production.version,
    rules: [{ id: 'ecuador', description: 'Launch market', clauses: [{ attribute: 'country', op: 'in', values: ['EC'] }], serve: { variation: 1 } }],
    fallthrough: { rollout: [{ variation: 1, weight: 20000 }, { variation: 0, weight: 80000 }] },
  }),
});
console.log(`propagated to SDK in ${((await changed) - t0).toFixed(1)} ms (PUT round-trip included)`);

const t1 = performance.now();
const after = count();
console.log(`after: ${after} of 10000 users (EC rule + 20% rollout), evaluated in ${(performance.now() - t1).toFixed(1)} ms`);
console.log('detail for user-1:', client.variationDetail('new-checkout', users[1], false));
client.close();
