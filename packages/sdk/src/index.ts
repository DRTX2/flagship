import { evaluate, type Context, type Evaluation, type FlagConfig, type Value } from '@flagship/core';

export type { Context, Evaluation, FlagConfig, Value } from '@flagship/core';

export interface FlagshipOptions {
  sdkKey: string;
  baseUrl: string;
  /** How long init() waits for the first ruleset before resolving with fallbacks. */
  initTimeoutMs?: number;
  /** Bootstrap flags (e.g. from a file or SSR) so evaluation works before/without the network. */
  bootstrap?: Record<string, FlagConfig>;
  fetch?: typeof fetch;
  logger?: Pick<Console, 'warn'>;
}

type Listener = (key: string) => void;

/**
 * Server-side SDK. Evaluation is local and synchronous (no network per call, keeps working
 * during an outage with the last known ruleset); updates arrive over a streaming connection.
 */
export class FlagshipClient {
  private flags = new Map<string, FlagConfig>();
  private listeners = new Set<Listener>();
  private abort = new AbortController();
  private ready = false;
  private readyWaiters: (() => void)[] = [];
  private retries = 0;
  private readonly fetch: typeof fetch;
  private readonly log: Pick<Console, 'warn'>;

  private constructor(private readonly opts: FlagshipOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.log = opts.logger ?? console;
    for (const [k, f] of Object.entries(opts.bootstrap ?? {})) this.flags.set(k, f);
  }

  static async init(opts: FlagshipOptions): Promise<FlagshipClient> {
    const client = new FlagshipClient(opts);
    void client.connect();
    await client.waitUntilReady(opts.initTimeoutMs ?? 5000);
    return client;
  }

  get initialized(): boolean {
    return this.ready;
  }

  variation<T extends Value>(key: string, context: Context, fallback: T): T {
    return this.variationDetail(key, context, fallback).value;
  }

  variationDetail<T extends Value>(key: string, context: Context, fallback: T): Evaluation<T> {
    const result = evaluate(this.flags.get(key), context, fallback);
    // A string flag read as boolean is a bug in the caller: never hand back the wrong type.
    if (fallback !== null && result.value !== null && typeof result.value !== typeof fallback) {
      return { value: fallback, variationIndex: null, reason: { kind: 'ERROR', error: 'MALFORMED_FLAG' } };
    }
    return result;
  }

  allFlags(context: Context): Record<string, Value> {
    return Object.fromEntries([...this.flags.keys()].map((k) => [k, evaluate(this.flags.get(k), context, null).value]));
  }

  /** Called with the flag key whenever a flag changes. Returns an unsubscribe function. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.abort.abort();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- internals

  private waitUntilReady(timeoutMs: number): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.log.warn('[flagship] init timed out, serving bootstrap/fallback values until connected');
        resolve();
      }, timeoutMs);
      this.readyWaiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  private markReady() {
    if (this.ready) return;
    this.ready = true;
    this.readyWaiters.splice(0).forEach((fn) => fn());
  }

  private async connect(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        const res = await this.fetch(`${this.opts.baseUrl}/sdk/v1/stream`, {
          headers: { authorization: `Bearer ${this.opts.sdkKey}`, accept: 'text/event-stream' },
          signal: this.abort.signal,
        });
        if (res.status === 401) {
          this.log.warn('[flagship] invalid SDK key, giving up'); // retrying will not fix a bad key
          this.markReady();
          return;
        }
        if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
        await this.consume(res.body);
        throw new Error('stream closed by server');
      } catch (e) {
        if (this.abort.signal.aborted) return;
        // Exponential backoff with full jitter, capped at 30s.
        const delay = Math.random() * Math.min(30_000, 500 * 2 ** this.retries++);
        this.log.warn(`[flagship] ${(e as Error).message}; reconnecting in ${Math.round(delay)}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async consume(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n'); // CRLF may straddle chunks
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        this.handleEvent(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
      }
    }
  }

  /** Exposed for tests: applies one raw SSE frame. */
  handleEvent(frame: string) {
    let type = 'message';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (type === 'ping' || !data.length) return;
    const payload = JSON.parse(data.join('\n'));

    if (type === 'put') {
      const next = new Map(Object.entries(payload.flags as Record<string, FlagConfig>));
      const changed = new Set([...this.flags.keys(), ...next.keys()]);
      for (const k of [...changed]) if (JSON.stringify(this.flags.get(k)) === JSON.stringify(next.get(k))) changed.delete(k);
      this.flags = next;
      this.retries = 0;
      this.markReady();
      changed.forEach((k) => this.emit(k));
    } else if (type === 'patch') {
      const flag = payload.flag as FlagConfig;
      const current = this.flags.get(flag.key);
      if (current && current.version >= flag.version) return; // out-of-order or duplicate
      this.flags.set(flag.key, flag);
      this.emit(flag.key);
    } else if (type === 'delete') {
      if (this.flags.delete(payload.key)) this.emit(payload.key);
    }
  }

  private emit(key: string) {
    for (const l of this.listeners) {
      try { l(key); } catch (e) { this.log.warn(`[flagship] listener threw: ${(e as Error).message}`); }
    }
  }
}
