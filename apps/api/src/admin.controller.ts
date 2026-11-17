import {
  Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { evaluate, OPS } from '@flagship/core';
import { z } from 'zod';
import { PG, type Db } from './db/db.js';
import { Actor, AdminGuard, hashKey, newSdkKey, Zod } from './http.js';
import { FlagsService } from './flags.service.js';

const key = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'lowercase letters, digits, . _ -');
const serve = z.union([
  z.object({ variation: z.number().int() }),
  z.object({
    rollout: z.array(z.object({ variation: z.number().int(), weight: z.number().int() })).min(1).max(20),
    bucketBy: z.string().max(64).optional(),
  }),
]);
const ConfigBody = z.object({
  enabled: z.boolean(),
  offVariation: z.number().int(),
  fallthrough: serve,
  rules: z.array(z.object({
    id: z.string().min(1).max(64),
    description: z.string().max(200).optional(),
    clauses: z.array(z.object({
      attribute: z.string().min(1).max(64),
      op: z.enum(OPS),
      values: z.array(z.union([z.string().max(256), z.number()])).max(500),
      negate: z.boolean().optional(),
    })).max(20),
    serve,
  })).max(100),
  version: z.number().int(),
});
const CreateFlag = z.object({
  key, name: z.string().min(1).max(100), description: z.string().max(500).optional(),
  kind: z.enum(['boolean', 'string', 'number', 'json']),
  variations: z.array(z.any()).min(2).max(20),
});

@Controller('api')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(@Inject(PG) private readonly db: Db, private readonly flags: FlagsService) {}

  @Get('environments')
  async environments() {
    const { rows } = await this.db.query(
      `SELECT key, name, sdk_key_hint AS "sdkKeyHint", created_at AS "createdAt" FROM environments ORDER BY created_at, key`,
    );
    return rows;
  }

  @Post('environments')
  async createEnvironment(@Body(new Zod(z.object({ key, name: z.string().min(1).max(60) }))) body: { key: string; name: string }) {
    const sdkKey = newSdkKey();
    await this.db.query(
      `WITH e AS (INSERT INTO environments (key, name, sdk_key_hash, sdk_key_hint) VALUES ($1,$2,$3,$4) RETURNING id)
       INSERT INTO flag_configs (flag_id, env_id, enabled, off_variation, fallthrough)
       SELECT f.id, e.id, false, 0, '{"variation":1}' FROM flags f, e`,
      [body.key, body.name, hashKey(sdkKey), sdkKey.slice(-4)],
    );
    return { ...body, sdkKey };
  }

  /** Rotation invalidates the old key immediately; the new one is only ever shown here. */
  @Post('environments/:env/sdk-key')
  async rotateKey(@Param('env') env: string) {
    const sdkKey = newSdkKey();
    const r = await this.db.query('UPDATE environments SET sdk_key_hash=$2, sdk_key_hint=$3 WHERE key=$1', [env, hashKey(sdkKey), sdkKey.slice(-4)]);
    if (!r.rowCount) throw new NotFoundException();
    return { env, sdkKey };
  }

  @Get('flags')
  async list(@Query('env') env = 'production') {
    const { rows } = await this.db.query(
      `SELECT f.key, f.name, f.description, f.kind, f.variations, f.created_at AS "createdAt",
              c.enabled, c.version, c.off_variation AS "offVariation", jsonb_array_length(c.rules)::int AS "ruleCount", c.fallthrough, c.updated_at AS "updatedAt"
         FROM flags f JOIN flag_configs c ON c.flag_id=f.id JOIN environments e ON e.id=c.env_id
        WHERE e.key=$1 AND f.archived_at IS NULL ORDER BY f.created_at DESC`,
      [env],
    );
    return rows;
  }

  @Post('flags')
  create(@Body(new Zod(CreateFlag)) body: z.infer<typeof CreateFlag>, @Actor() actor: string) {
    return this.flags.create(body, actor);
  }

  @Get('flags/:key')
  async get(@Param('key') flagKey: string) {
    const { rows } = await this.db.query(
      `SELECT f.key, f.name, f.description, f.kind, f.variations, f.created_at AS "createdAt",
              json_object_agg(e.key, json_build_object(
                'enabled', c.enabled, 'offVariation', c.off_variation, 'fallthrough', c.fallthrough,
                'rules', c.rules, 'version', c.version, 'updatedAt', c.updated_at)) AS envs
         FROM flags f JOIN flag_configs c ON c.flag_id=f.id JOIN environments e ON e.id=c.env_id
        WHERE f.key=$1 AND f.archived_at IS NULL GROUP BY f.id`,
      [flagKey],
    );
    if (!rows[0]) throw new NotFoundException();
    return rows[0];
  }

  @Put('flags/:key/envs/:env')
  update(@Param('key') flagKey: string, @Param('env') env: string, @Body(new Zod(ConfigBody)) body: z.infer<typeof ConfigBody>, @Actor() actor: string) {
    return this.flags.updateConfig(flagKey, env, body, actor);
  }

  @Delete('flags/:key')
  @HttpCode(204)
  archive(@Param('key') flagKey: string, @Actor() actor: string) {
    return this.flags.archive(flagKey, actor);
  }

  @Get('flags/:key/audit')
  async audit(@Param('key') flagKey: string) {
    const { rows } = await this.db.query(
      `SELECT id, env_key AS env, actor, action, before, after, created_at AS "createdAt"
         FROM audit_log WHERE flag_key=$1 ORDER BY created_at DESC LIMIT 100`,
      [flagKey],
    );
    return rows;
  }

  /** "Why does this user get this value?" using the same engine the SDKs run. */
  @Post('flags/:key/envs/:env/explain')
  async explain(
    @Param('key') flagKey: string, @Param('env') env: string,
    @Body(new Zod(z.object({ context: z.looseObject({ key: z.string().min(1) }) }))) body: { context: { key: string } },
  ) {
    const flag = await this.flags.config(flagKey, env);
    if (!flag) throw new NotFoundException();
    return evaluate(flag, body.context, null);
  }
}
