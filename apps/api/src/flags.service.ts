import { randomBytes } from 'node:crypto';
import {
  BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException,
  type OnModuleDestroy, type OnModuleInit,
} from '@nestjs/common';
import type { FlagConfig, Rule, Serve, Value } from '@flagship/core';
import { validateFlag } from '@flagship/core';
import pg from 'pg';
import { filter, Subject } from 'rxjs';
import { PG, required, tx, type Db } from './db/db.js';

export interface ConfigInput {
  enabled: boolean;
  offVariation: number;
  fallthrough: Serve;
  rules: Rule[];
  version: number; // the version the editor started from
}

export type Change = { env: string; key: string; flag: FlagConfig | null } | { resync: true };

const CONFIG_SQL = `
  SELECT f.key, f.variations, f.salt, c.enabled, c.off_variation AS "offVariation",
         c.fallthrough, c.rules, c.version
    FROM flag_configs c JOIN flags f ON f.id = c.flag_id`;

@Injectable()
export class FlagsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Flags');
  private readonly changes$ = new Subject<Change>();
  private listener?: pg.Client;
  private stopped = false;

  constructor(@Inject(PG) private readonly db: Db) {}

  /** Full ruleset for one environment: what SDKs download and keep in memory. */
  async rulesetForEnv(envId: string): Promise<Record<string, FlagConfig>> {
    const { rows } = await this.db.query(`${CONFIG_SQL} WHERE c.env_id=$1 AND f.archived_at IS NULL`, [envId]);
    return Object.fromEntries(rows.map((r) => [r.key, r as FlagConfig]));
  }

  async config(flagKey: string, envKey: string): Promise<FlagConfig | null> {
    const { rows } = await this.db.query(
      `${CONFIG_SQL} JOIN environments e ON e.id = c.env_id WHERE f.key=$1 AND e.key=$2 AND f.archived_at IS NULL`,
      [flagKey, envKey],
    );
    return rows[0] ?? null;
  }

  async create(input: { key: string; name: string; description?: string; kind: string; variations: Value[] }, actor: string) {
    const errors = validateFlag({ variations: input.variations, offVariation: 0, fallthrough: { variation: 1 }, rules: [] });
    if (errors.length) throw new BadRequestException(errors);
    return tx(this.db, async (c) => {
      const dup = await c.query('SELECT 1 FROM flags WHERE key=$1', [input.key]);
      if (dup.rowCount) throw new ConflictException(`Flag "${input.key}" already exists`);
      const { rows } = await c.query(
        `INSERT INTO flags (key, name, description, kind, variations, salt) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [input.key, input.name, input.description ?? null, input.kind, JSON.stringify(input.variations), randomBytes(8).toString('hex')],
      );
      // New flags start OFF everywhere; turning one on serves variation 1 (e.g. `true`).
      await c.query(
        `INSERT INTO flag_configs (flag_id, env_id, enabled, off_variation, fallthrough)
         SELECT $1, id, false, 0, '{"variation":1}' FROM environments`,
        [rows[0].id],
      );
      await c.query(`INSERT INTO audit_log (flag_key, actor, action, after) VALUES ($1,$2,'created',$3)`, [input.key, actor, input]);
      const envs = await c.query('SELECT key FROM environments');
      for (const e of envs.rows) await this.notify(c, e.key, input.key);
      return { key: input.key };
    });
  }

  /**
   * Optimistic concurrency: two people editing the same flag cannot silently overwrite
   * each other. pg_notify inside the transaction is only delivered if it commits.
   */
  async updateConfig(flagKey: string, envKey: string, input: ConfigInput, actor: string) {
    return tx(this.db, async (c) => {
      const { rows } = await c.query(
        `SELECT c.flag_id, c.env_id, f.variations, c.enabled, c.off_variation AS "offVariation", c.fallthrough, c.rules, c.version
           FROM flag_configs c JOIN flags f ON f.id=c.flag_id JOIN environments e ON e.id=c.env_id
          WHERE f.key=$1 AND e.key=$2 AND f.archived_at IS NULL FOR UPDATE OF c`,
        [flagKey, envKey],
      );
      const cur = rows[0];
      if (!cur) throw new NotFoundException();
      if (cur.version !== input.version) {
        throw new ConflictException(`Flag was changed by someone else (now v${cur.version}). Reload and re-apply your edit.`);
      }
      const errors = validateFlag({ variations: cur.variations, offVariation: input.offVariation, fallthrough: input.fallthrough, rules: input.rules });
      if (errors.length) throw new BadRequestException(errors);

      const next = { enabled: input.enabled, offVariation: input.offVariation, fallthrough: input.fallthrough, rules: input.rules };
      await c.query(
        `UPDATE flag_configs SET enabled=$3, off_variation=$4, fallthrough=$5, rules=$6, version=version+1, updated_at=now()
          WHERE flag_id=$1 AND env_id=$2`,
        [cur.flag_id, cur.env_id, next.enabled, next.offVariation, JSON.stringify(next.fallthrough), JSON.stringify(next.rules)],
      );
      const before = { enabled: cur.enabled, offVariation: cur.offVariation, fallthrough: cur.fallthrough, rules: cur.rules };
      const action = before.enabled !== next.enabled ? (next.enabled ? 'turned on' : 'turned off') : 'updated targeting';
      await c.query(
        `INSERT INTO audit_log (flag_key, env_key, actor, action, before, after) VALUES ($1,$2,$3,$4,$5,$6)`,
        [flagKey, envKey, actor, action, before, next],
      );
      await this.notify(c, envKey, flagKey);
      return { version: input.version + 1 };
    });
  }

  async archive(flagKey: string, actor: string) {
    await tx(this.db, async (c) => {
      const r = await c.query('UPDATE flags SET archived_at=now() WHERE key=$1 AND archived_at IS NULL', [flagKey]);
      if (!r.rowCount) throw new NotFoundException();
      await c.query(`INSERT INTO audit_log (flag_key, actor, action) VALUES ($1,$2,'archived')`, [flagKey, actor]);
      const envs = await c.query('SELECT key FROM environments');
      for (const e of envs.rows) await this.notify(c, e.key, flagKey);
    });
  }

  changesFor(envKey: string) {
    return this.changes$.pipe(filter((ch) => 'resync' in ch || ch.env === envKey));
  }

  private notify(c: pg.PoolClient, env: string, key: string) {
    return c.query(`SELECT pg_notify('flag_changes', $1)`, [JSON.stringify({ env, key })]);
  }

  // --- LISTEN side: every API replica gets every change and fans it out to its own SSE clients.

  async onModuleInit() {
    await this.listen();
  }

  private async listen(reconnect = false) {
    const client = new pg.Client({ connectionString: required('DATABASE_URL') });
    client.on('notification', (n) => {
      const { env, key } = JSON.parse(n.payload ?? '{}');
      this.config(key, env)
        .then((flag) => this.changes$.next({ env, key, flag }))
        .catch((e) => this.log.error(e));
    });
    client.on('error', (e) => {
      this.log.warn(`LISTEN connection lost: ${e.message}, reconnecting`);
      client.end().catch(() => {});
      if (!this.stopped) setTimeout(() => this.listen(true).catch((err) => this.log.error(err)), 1000);
    });
    await client.connect();
    await client.query('LISTEN flag_changes');
    this.listener = client;
    // Notifications sent while we were disconnected are gone: tell SDKs to re-download everything.
    if (reconnect) this.changes$.next({ resync: true });
  }

  async onModuleDestroy() {
    this.stopped = true;
    await this.listener?.end();
  }
}
