import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  Body, Controller, Headers, HttpCode, Inject, Param, Post, Req, UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { PG, type Db } from './db/db.js';
import { Zod } from './http.js';
import { FlagsService } from './flags.service.js';

const TOLERANCE_SECONDS = 300;

/**
 * Verifies Nimbus' webhook signature: header `Nimbus-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`,
 * HMAC-SHA256 over `<unix>.<raw body>` with NIMBUS_WEBHOOK_SECRET. Several v1 values allow rotation.
 */
export function verifyNimbusSignature(secret: string, header: string | undefined, rawBody: Buffer, now = Date.now()): boolean {
  if (!secret || !header) return false;
  const parts = header.split(',').map((p) => p.trim());
  const t = Number(parts.find((p) => p.startsWith('t='))?.slice(2));
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  return parts
    .filter((p) => p.startsWith('v1='))
    .some((p) => {
      const got = Buffer.from(p.slice(3), 'hex');
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
}

const NimbusIncident = z.looseObject({
  incidentId: z.string().min(1).max(100),
  event: z.enum(['opened', 'recovered']),
  pipelineName: z.string().max(200).optional(),
  summary: z.string().max(1000).optional(),
});
type NimbusIncident = z.infer<typeof NimbusIncident>;

/**
 * Atalaya integration: a Nimbus incident workflow calls this URL as an HTTP step.
 * opened    -> kill switch: turn the flag off (audited, pushed to SDKs in milliseconds).
 * recovered -> restore the configuration from before *that incident's* kill, and only if
 *              nobody changed the flag since (humans always win over automation).
 * Idempotent: replays of the same incident are no-ops, so Nimbus' at-least-once retries are safe.
 */
@Controller('automation/nimbus')
export class NimbusAutomationController {
  constructor(@Inject(PG) private readonly db: Db, private readonly flags: FlagsService) {}

  @Post('flags/:key/envs/:env')
  @HttpCode(200)
  async handle(
    @Param('key') flagKey: string,
    @Param('env') env: string,
    @Headers('nimbus-signature') signature: string | undefined,
    @Req() req: Request & { rawBody?: Buffer },
    @Body(new Zod(NimbusIncident)) incident: NimbusIncident,
  ) {
    if (!verifyNimbusSignature(process.env.NIMBUS_WEBHOOK_SECRET ?? '', signature, req.rawBody ?? Buffer.alloc(0))) {
      throw new UnauthorizedException('Invalid Nimbus signature');
    }
    const marker = `nimbus incident ${incident.incidentId}`;
    const actor = 'nimbus (automation)';
    const flag = await this.flags.config(flagKey, env);
    if (!flag) return { changed: false, reason: 'flag not found or archived' };

    if (incident.event === 'opened') {
      if (!flag.enabled) return { changed: false, reason: 'already off' };
      const r = await this.flags.updateConfig(
        flagKey, env,
        { enabled: false, offVariation: flag.offVariation, fallthrough: flag.fallthrough, rules: flag.rules, version: flag.version },
        actor, `killed by ${marker}${incident.summary ? `: ${incident.summary}` : ''}`.slice(0, 300),
      );
      return { changed: true, action: 'killed', version: r.version };
    }

    // recovered: restore only if the latest change on this flag/env is still this incident's kill
    const { rows } = await this.db.query(
      `SELECT id, action FROM audit_log WHERE flag_key=$1 AND env_key=$2 ORDER BY id DESC LIMIT 1`,
      [flagKey, env],
    );
    if (!rows[0] || !String(rows[0].action).startsWith(`killed by ${marker}`)) {
      return { changed: false, reason: 'flag changed since the incident; leaving it to humans' };
    }
    const r = await this.flags.rollback(flagKey, env, Number(rows[0].id), actor);
    return { changed: true, action: 'restored', version: r.version };
  }
}
