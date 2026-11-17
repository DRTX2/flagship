import { describe, expect, it } from 'vitest';
import { bucket, evaluate, matchClause, murmur3, validateFlag, type Clause, type FlagConfig, type Value } from '../src/index.js';

const base: FlagConfig = {
  key: 'new-checkout', variations: [false, true], enabled: true, offVariation: 0,
  rules: [], fallthrough: { variation: 0 }, salt: 's1', version: 1,
};

describe('murmur3', () => {
  // Reference values from the canonical MurmurHash3_x86_32 implementation
  it.each([['', 0, 0], ['', 1, 0x514e28b7], ['hello', 0, 0x248bfa47], ['Hello, world!', 1234, 0xfaf6cdb3]] as const)(
    'murmur3(%j, %d)', (s, seed, expected) => expect(murmur3(s, seed)).toBe(expected),
  );
});

describe('percentage rollout', () => {
  const flag: FlagConfig = { ...base, fallthrough: { rollout: [{ variation: 1, weight: 25_000 }, { variation: 0, weight: 75_000 }] } };

  it('is sticky for the same user', () => {
    const a = evaluate(flag, { key: 'user-42' }, false);
    for (let i = 0; i < 5; i++) expect(evaluate(flag, { key: 'user-42' }, false)).toEqual(a);
  });

  it('splits 10k users close to 25/75', () => {
    let on = 0;
    for (let i = 0; i < 10_000; i++) if (evaluate(flag, { key: `u${i}` }, false).value) on++;
    expect(on / 10_000).toBeGreaterThan(0.23);
    expect(on / 10_000).toBeLessThan(0.27);
  });

  it('only adds users when the rollout grows (monotonic)', () => {
    const grown: FlagConfig = { ...flag, fallthrough: { rollout: [{ variation: 1, weight: 50_000 }, { variation: 0, weight: 50_000 }] } };
    for (let i = 0; i < 2000; i++) {
      if (evaluate(flag, { key: `u${i}` }, false).value) expect(evaluate(grown, { key: `u${i}` }, false).value).toBe(true);
    }
  });

  it('uses independent buckets per flag (salt)', () => {
    let same = 0;
    for (let i = 0; i < 1000; i++) if (bucket('a', 's', `u${i}`) < 50_000 === bucket('b', 's', `u${i}`) < 50_000) same++;
    expect(same).toBeGreaterThan(400);
    expect(same).toBeLessThan(600);
  });

  it('can bucket by another attribute (e.g. company)', () => {
    const byOrg: FlagConfig = { ...flag, fallthrough: { ...flag.fallthrough, bucketBy: 'orgId' } as FlagConfig['fallthrough'] };
    const a = evaluate(byOrg, { key: 'alice', orgId: 'acme' }, false);
    const b = evaluate(byOrg, { key: 'bob', orgId: 'acme' }, false);
    expect(a.value).toBe(b.value);
  });
});

describe('rules', () => {
  const flag: FlagConfig = {
    ...base,
    rules: [
      { id: 'staff', clauses: [{ attribute: 'email', op: 'endsWith', values: ['@acme.com'] }], serve: { variation: 1 } },
      {
        id: 'ec-mobile',
        clauses: [
          { attribute: 'country', op: 'in', values: ['EC', 'CO'] },
          { attribute: 'appVersion', op: 'semverGte', values: ['2.4.0'] },
        ],
        serve: { variation: 1 },
      },
      { id: 'not-free', clauses: [{ attribute: 'plan', op: 'in', values: ['free'], negate: true }], serve: { variation: 1 } },
    ],
  };

  it.each([
    [{ key: '1', email: 'dev@acme.com' }, true, 'RULE_MATCH'],
    [{ key: '2', country: 'EC', appVersion: '2.10.1' }, true, 'RULE_MATCH'],
    [{ key: '3', country: 'EC', appVersion: '2.3.9' }, false, 'FALLTHROUGH'],
    [{ key: '4', plan: 'pro' }, true, 'RULE_MATCH'],
    [{ key: '5', plan: 'free' }, false, 'FALLTHROUGH'],
    [{ key: '6' }, false, 'FALLTHROUGH'], // missing attribute never matches a negated clause
  ])('%j -> %s', (ctx, value, kind) => {
    const r = evaluate(flag, ctx, false);
    expect(r.value).toBe(value);
    expect(r.reason.kind).toBe(kind);
  });

  it('matches array attributes when any element matches', () => {
    const f: FlagConfig = { ...base, rules: [{ id: 'b', clauses: [{ attribute: 'groups', op: 'in', values: ['beta'] }], serve: { variation: 1 } }] };
    expect(evaluate(f, { key: 'x', groups: ['staff', 'beta'] }, false).value).toBe(true);
  });

  it('reports which rule matched', () => {
    expect(evaluate(flag, { key: '1', email: 'a@acme.com' }, false).reason).toEqual({ kind: 'RULE_MATCH', ruleIndex: 0, ruleId: 'staff' });
  });
});

describe('off, errors, fallback', () => {
  it('serves offVariation when disabled, ignoring rules', () => {
    const f: FlagConfig = { ...base, enabled: false, fallthrough: { variation: 1 } };
    expect(evaluate(f, { key: 'a' }, true)).toEqual({ value: false, variationIndex: 0, reason: { kind: 'OFF' } });
  });
  it('returns the fallback for unknown or malformed flags', () => {
    expect(evaluate(undefined, { key: 'a' }, 'x').value).toBe('x');
    expect(evaluate({ ...base, offVariation: 9, enabled: false }, { key: 'a' }, true).reason).toEqual({ kind: 'ERROR', error: 'MALFORMED_FLAG' });
  });
});

describe('validateFlag', () => {
  it('accepts a valid flag', () => expect(validateFlag(base)).toEqual([]));
  it('rejects bad configs', () => {
    const errors = validateFlag({
      variations: [true, 'x'],
      offVariation: 5,
      fallthrough: { rollout: [{ variation: 0, weight: 50_000 }] },
      rules: [{ id: 'r', clauses: [], serve: { variation: 1 } }],
    });
    expect(errors).toEqual(expect.arrayContaining([
      'All variations must have the same type',
      'offVariation: variation 5 does not exist',
      'fallthrough: rollout weights must sum to 100% (got 50%)',
      'rule 1: needs at least one condition',
    ]));
  });
});

describe('operators', () => {
  const one = (op: Clause['op'], actual: unknown, values: (string | number)[], negate = false) =>
    matchClause({ attribute: 'a', op, values, negate }, { key: 'k', a: actual });
  it.each([
    ['in', 'EC', ['EC', 'CO'], true], ['in', 'PE', ['EC'], false], ['in', 42, ['42'], true], ['in', 42, [42], true],
    ['contains', 'ana@acme.com', ['@acme'], true], ['contains', 123, ['1'], false],
    ['startsWith', 'beta-user', ['beta'], true], ['startsWith', 'user-beta', ['beta'], false], ['startsWith', 5, ['5'], false],
    ['endsWith', 'x@acme.com', ['.com'], true], ['endsWith', 'x@acme.io', ['.com'], false], ['endsWith', 5, ['5'], false],
    ['lt', 9, [10], true], ['lt', 10, [10], false], ['lt', '9', [10], false],
    ['lte', 10, [10], true], ['lte', 11, [10], false], ['lte', '10', [10], false],
    ['gt', 11, [10], true], ['gt', 10, [10], false], ['gt', '11', [10], false],
    ['gte', 10, [10], true], ['gte', 9, [10], false], ['gte', '10', [10], false],
    ['semverGte', 'v2.4.0', ['2.4'], true], ['semverGte', '2.3.99', ['2.4.0'], false], ['semverGte', '3', ['2.10.0'], true],
    ['semverLt', '2.3.9', ['2.4.0'], true], ['semverLt', '2.4.0', ['2.4.0'], false],
    ['semverGte', 'latest', ['1.0.0'], false], ['semverLt', '1.0.0', ['not-a-version'], false],
  ] as const)('%s(%j, %j) = %s', (op, actual, values, expected) => expect(one(op, actual, [...values])).toBe(expected));

  it('negates', () => {
    expect(one('in', 'EC', ['US'], true)).toBe(true);
    expect(one('in', 'US', ['US'], true)).toBe(false);
  });
});

describe('rollout edge cases', () => {
  it('falls back to the last variation if an unvalidated rollout does not reach 100%', () => {
    const f: FlagConfig = { ...base, fallthrough: { rollout: [{ variation: 1, weight: 1 }, { variation: 0, weight: 1 }] } };
    const r = evaluate(f, { key: 'someone' }, false);
    expect(r.bucket).toBeGreaterThanOrEqual(2);
    expect(r.variationIndex).toBe(0);
  });
  it('buckets users with a missing bucketBy attribute together', () => {
    const f: FlagConfig = { ...base, fallthrough: { rollout: [{ variation: 1, weight: 50_000 }, { variation: 0, weight: 50_000 }], bucketBy: 'orgId' } };
    expect(evaluate(f, { key: 'a' }, false).bucket).toBe(evaluate(f, { key: 'b' }, false).bucket);
  });
});

describe('validateFlag (every rule)', () => {
  const ok = { variations: [false, true] as Value[], offVariation: 0, fallthrough: { variation: 1 } as FlagConfig['fallthrough'], rules: [] as FlagConfig['rules'] };
  const rule = (over: Partial<FlagConfig['rules'][number]> = {}) => ({ id: 'r', clauses: [{ attribute: 'a', op: 'in' as const, values: ['x'] }], serve: { variation: 1 }, ...over });
  it.each([
    ['fewer than two variations', { variations: [true] }, 'at least two variations'],
    ['rollout with no entries', { fallthrough: { rollout: [] } }, 'rollout is empty'],
    ['negative weight', { fallthrough: { rollout: [{ variation: 0, weight: -1 }, { variation: 1, weight: 100_001 }] } }, 'non-negative integers'],
    ['fractional weight', { fallthrough: { rollout: [{ variation: 0, weight: 0.5 }, { variation: 1, weight: 99_999.5 }] } }, 'non-negative integers'],
    ['unknown variation in rule', { rules: [rule({ serve: { variation: 7 } })] }, 'rule 1: variation 7 does not exist'],
    ['duplicate rule ids', { rules: [rule(), rule()] }, 'rule 2: duplicate id'],
    ['unknown operator', { rules: [rule({ clauses: [{ attribute: 'a', op: 'regex' as never, values: ['x'] }] })] }, 'unknown operator regex'],
    ['empty attribute', { rules: [rule({ clauses: [{ attribute: '', op: 'in', values: ['x'] }] })] }, 'attribute is required'],
    ['no values', { rules: [rule({ clauses: [{ attribute: 'a', op: 'in', values: [] }] })] }, 'at least one value'],
  ])('rejects %s', (_name, over, message) => {
    expect(validateFlag({ ...ok, ...over } as Parameters<typeof validateFlag>[0]).join(' | ')).toContain(message);
  });
});
