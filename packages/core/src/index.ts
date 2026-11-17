/**
 * Flag evaluation engine. Pure and isomorphic: the server SDK, a browser SDK and the API's
 * "explain" endpoint all run this exact code, so the dashboard can never disagree with production.
 */

export type Value = boolean | string | number | null | Record<string, unknown> | unknown[];

export const OPS = ['in', 'contains', 'startsWith', 'endsWith', 'lt', 'lte', 'gt', 'gte', 'semverGte', 'semverLt'] as const;
export type Op = (typeof OPS)[number];

export interface Clause {
  attribute: string;
  op: Op;
  values: (string | number)[];
  negate?: boolean;
}

export interface WeightedVariation {
  variation: number;
  /** In thousandths of a percent: all weights of a rollout sum to 100_000. */
  weight: number;
}

export type Serve = { variation: number } | { rollout: WeightedVariation[]; bucketBy?: string };

export interface Rule {
  id: string;
  description?: string;
  clauses: Clause[]; // AND
  serve: Serve;
}

export interface FlagConfig {
  key: string;
  variations: Value[];
  enabled: boolean;
  offVariation: number;
  rules: Rule[]; // first match wins
  fallthrough: Serve;
  /** Per-flag salt: the same user lands in independent buckets for different flags. */
  salt: string;
  version: number;
}

export interface Context {
  key: string;
  [attribute: string]: unknown;
}

export type Reason =
  | { kind: 'OFF' }
  | { kind: 'RULE_MATCH'; ruleIndex: number; ruleId: string }
  | { kind: 'FALLTHROUGH' }
  | { kind: 'ERROR'; error: 'FLAG_NOT_FOUND' | 'MALFORMED_FLAG' };

export interface Evaluation<T = Value> {
  value: T;
  variationIndex: number | null;
  reason: Reason;
  /** 0..99_999 when a percentage rollout decided the result. */
  bucket?: number;
}

export const BUCKETS = 100_000;

/** MurmurHash3 x86 32-bit: fast, well distributed, identical on every JS runtime. */
export function murmur3(input: string, seed = 0): number {
  const bytes = new TextEncoder().encode(input);
  let h = seed >>> 0;
  const c1 = 0xcc9e2d51, c2 = 0x1b873593;
  const tail = bytes.length & ~3;
  for (let i = 0; i < tail; i += 4) {
    let k = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  switch (bytes.length & 3) {
    case 3: k ^= bytes[tail + 2] << 16; // falls through
    case 2: k ^= bytes[tail + 1] << 8; // falls through
    case 1:
      k ^= bytes[tail];
      k = Math.imul(k, c1); k = (k << 15) | (k >>> 17); k = Math.imul(k, c2); h ^= k;
  }
  h ^= bytes.length;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic bucket in [0, 100_000): sticky per (flag, salt, user) with no stored state. */
export function bucket(flagKey: string, salt: string, value: string): number {
  return Math.floor((murmur3(`${flagKey}.${salt}.${value}`) / 2 ** 32) * BUCKETS);
}

function semver(v: unknown): number[] | null {
  const m = String(v).match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

function cmpSemver(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function matchOne(op: Op, actual: unknown, expected: string | number): boolean {
  switch (op) {
    case 'in': return actual === expected || (typeof actual === 'number' && String(actual) === String(expected));
    case 'contains': return typeof actual === 'string' && actual.includes(String(expected));
    case 'startsWith': return typeof actual === 'string' && actual.startsWith(String(expected));
    case 'endsWith': return typeof actual === 'string' && actual.endsWith(String(expected));
    case 'lt': return typeof actual === 'number' && actual < Number(expected);
    case 'lte': return typeof actual === 'number' && actual <= Number(expected);
    case 'gt': return typeof actual === 'number' && actual > Number(expected);
    case 'gte': return typeof actual === 'number' && actual >= Number(expected);
    case 'semverGte':
    case 'semverLt': {
      const a = semver(actual), b = semver(expected);
      if (!a || !b) return false;
      return op === 'semverGte' ? cmpSemver(a, b) >= 0 : cmpSemver(a, b) < 0;
    }
  }
}

export function matchClause(clause: Clause, ctx: Context): boolean {
  const raw = ctx[clause.attribute];
  // Missing attribute never matches, even when negated: "country not in [US]" must not
  // silently include users whose country is unknown.
  if (raw === undefined || raw === null) return false;
  const actuals = Array.isArray(raw) ? raw : [raw]; // array attributes match if any element matches
  const hit = actuals.some((a) => clause.values.some((v) => matchOne(clause.op, a, v)));
  return clause.negate ? !hit : hit;
}

function serve(flag: FlagConfig, s: Serve, ctx: Context): { index: number; bucket?: number } {
  if ('variation' in s) return { index: s.variation };
  const by = s.bucketBy ?? 'key';
  const b = bucket(flag.key, flag.salt, String(ctx[by] ?? ''));
  let acc = 0;
  for (const wv of s.rollout) {
    acc += wv.weight;
    if (b < acc) return { index: wv.variation, bucket: b };
  }
  return { index: s.rollout[s.rollout.length - 1].variation, bucket: b }; // weights validated to 100%
}

export function evaluate<T extends Value = Value>(flag: FlagConfig | undefined, ctx: Context, fallback: T): Evaluation<T> {
  if (!flag) return { value: fallback, variationIndex: null, reason: { kind: 'ERROR', error: 'FLAG_NOT_FOUND' } };
  const pick = (index: number, reason: Reason, b?: number): Evaluation<T> => {
    if (index < 0 || index >= flag.variations.length) {
      return { value: fallback, variationIndex: null, reason: { kind: 'ERROR', error: 'MALFORMED_FLAG' } };
    }
    return { value: flag.variations[index] as T, variationIndex: index, reason, ...(b !== undefined && { bucket: b }) };
  };

  if (!flag.enabled) return pick(flag.offVariation, { kind: 'OFF' });
  for (let i = 0; i < flag.rules.length; i++) {
    const rule = flag.rules[i];
    if (rule.clauses.every((c) => matchClause(c, ctx))) {
      const r = serve(flag, rule.serve, ctx);
      return pick(r.index, { kind: 'RULE_MATCH', ruleIndex: i, ruleId: rule.id }, r.bucket);
    }
  }
  const r = serve(flag, flag.fallthrough, ctx);
  return pick(r.index, { kind: 'FALLTHROUGH' }, r.bucket);
}

/** Structural validation run by the API before any flag config is saved. */
export function validateFlag(flag: Pick<FlagConfig, 'variations' | 'offVariation' | 'rules' | 'fallthrough'>): string[] {
  const errors: string[] = [];
  const n = flag.variations.length;
  if (n < 2) errors.push('A flag needs at least two variations');
  const types = new Set(flag.variations.map((v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)));
  if (types.size > 1) errors.push('All variations must have the same type');
  const checkIndex = (i: number, where: string) => {
    if (!Number.isInteger(i) || i < 0 || i >= n) errors.push(`${where}: variation ${i} does not exist`);
  };
  const checkServe = (s: Serve, where: string) => {
    if ('variation' in s) return checkIndex(s.variation, where);
    if (!s.rollout.length) errors.push(`${where}: rollout is empty`);
    s.rollout.forEach((wv) => {
      checkIndex(wv.variation, where);
      if (!Number.isInteger(wv.weight) || wv.weight < 0) errors.push(`${where}: weights must be non-negative integers`);
    });
    const total = s.rollout.reduce((a, wv) => a + wv.weight, 0);
    if (total !== BUCKETS) errors.push(`${where}: rollout weights must sum to 100% (got ${total / 1000}%)`);
  };
  checkIndex(flag.offVariation, 'offVariation');
  checkServe(flag.fallthrough, 'fallthrough');
  const ids = new Set<string>();
  flag.rules.forEach((r, i) => {
    if (ids.has(r.id)) errors.push(`rule ${i + 1}: duplicate id`);
    ids.add(r.id);
    if (!r.clauses.length) errors.push(`rule ${i + 1}: needs at least one condition`);
    r.clauses.forEach((c) => {
      if (!OPS.includes(c.op)) errors.push(`rule ${i + 1}: unknown operator ${c.op}`);
      if (!c.attribute) errors.push(`rule ${i + 1}: attribute is required`);
      if (!c.values.length) errors.push(`rule ${i + 1}: condition needs at least one value`);
    });
    checkServe(r.serve, `rule ${i + 1}`);
  });
  return errors;
}
