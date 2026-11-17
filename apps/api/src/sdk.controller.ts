import { createHash } from 'node:crypto';
import { Controller, Get, Headers, Res, Sse, UseGuards, type MessageEvent } from '@nestjs/common';
import type { Response } from 'express';
import { concat, defer, finalize, from, interval, map, merge, mergeMap, type Observable, tap } from 'rxjs';
import { metrics } from './common/metrics.js';
import { Env, SdkGuard } from './http.js';
import { FlagsService } from './flags.service.js';

type EnvRef = { id: string; key: string };

/**
 * SDKs never call us per evaluation: they download the ruleset once, evaluate locally
 * (microseconds, works offline) and receive incremental patches over SSE.
 */
@Controller('sdk/v1')
@UseGuards(SdkGuard)
export class SdkController {
  constructor(private readonly flags: FlagsService) {}

  @Get('flags')
  async ruleset(@Env() env: EnvRef, @Headers('if-none-match') inm: string | undefined, @Res({ passthrough: true }) res: Response) {
    const flags = await this.flags.rulesetForEnv(env.id);
    const etag = `"${createHash('sha1').update(JSON.stringify(flags)).digest('base64url')}"`;
    res.setHeader('etag', etag);
    res.setHeader('cache-control', 'no-cache');
    if (inm === etag) {
      res.status(304);
      return;
    }
    return { flags };
  }

  /** `put` = full ruleset (on connect and after resync), `patch` = one flag changed, `delete` = archived. */
  @Sse('stream')
  stream(@Env() env: EnvRef): Observable<MessageEvent> {
    const put = () => defer(() => from(this.flags.rulesetForEnv(env.id))).pipe(map((flags) => ({ type: 'put', data: { flags } }) as MessageEvent));
    const changes = this.flags.changesFor(env.key).pipe(
      mergeMap((ch): Observable<MessageEvent> => {
        if ('resync' in ch) return put();
        return from([ch.flag
          ? ({ type: 'patch', data: { flag: ch.flag } } as MessageEvent)
          : ({ type: 'delete', data: { key: ch.key } } as MessageEvent)]);
      }),
    );
    const heartbeat = interval(25_000).pipe(map(() => ({ type: 'ping', data: '' }) as MessageEvent));
    // Count on subscribe/unsubscribe so the gauge matches real open streams.
    return defer(() => {
      metrics.sseConnections.inc({ env: env.key });
      return concat(put(), merge(changes, heartbeat));
    }).pipe(
      tap((e) => e.type !== 'ping' && metrics.pushes.inc({ type: String(e.type) })),
      finalize(() => metrics.sseConnections.dec({ env: env.key })),
    );
  }
}
