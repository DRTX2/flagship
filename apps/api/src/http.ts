import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException, type CanActivate, createParamDecorator, type ExecutionContext,
  Inject, Injectable, type PipeTransform, UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { ZodType } from 'zod';
import { PG, type Db } from './db/db.js';

export const hashKey = (k: string) => createHash('sha256').update(k).digest('hex');
export const newSdkKey = () => 'fs_sdk_' + randomBytes(24).toString('base64url');

type Req = Request & { envId?: string; envKey?: string; actor?: string };

/**
 * Dashboard/management auth. shortcut: one shared admin token + self-declared actor name for
 * the audit log; swap for SSO/OIDC with real user identities before multi-team use.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Req>();
    const given = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
    const expected = Buffer.from(process.env.ADMIN_TOKEN ?? '');
    if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new UnauthorizedException();
    }
    req.actor = String(req.headers['x-actor'] ?? 'unknown').slice(0, 80);
    return true;
  }
}

/** SDK auth: the key identifies exactly one environment. */
@Injectable()
export class SdkGuard implements CanActivate {
  constructor(@Inject(PG) private readonly db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Req>();
    const key = req.headers.authorization?.match(/^Bearer (fs_sdk_[\w-]+)$/)?.[1];
    if (!key) throw new UnauthorizedException('Missing SDK key');
    const { rows } = await this.db.query('SELECT id, key FROM environments WHERE sdk_key_hash=$1', [hashKey(key)]);
    if (!rows[0]) throw new UnauthorizedException('Invalid SDK key');
    req.envId = rows[0].id;
    req.envKey = rows[0].key;
    return true;
  }
}

export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<Req>().actor!);
export const Env = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const r = ctx.switchToHttp().getRequest<Req>();
  return { id: r.envId!, key: r.envKey! };
});

export class Zod<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`));
    return r.data;
  }
}
