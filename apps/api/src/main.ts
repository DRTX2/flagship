import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { createLogger } from './common/logger.js';
import { registry } from './common/metrics.js';
import { requestLogger } from './common/request-logger.js';
import { createPool, migrate, PG } from './db/db.js';
import { AdminController } from './admin.controller.js';
import { SdkController } from './sdk.controller.js';
import { FlagsService } from './flags.service.js';
import { AdminGuard, SdkGuard } from './http.js';
import { HookrelayNotifier } from './hookrelay-notifier.js';
import { NimbusAutomationController } from './nimbus-automation.controller.js';

@Module({
  controllers: [AdminController, SdkController, NimbusAutomationController],
  providers: [{ provide: PG, useFactory: createPool }, FlagsService, HookrelayNotifier, AdminGuard, SdkGuard],
})
class AppModule {}

const pool = createPool();
await migrate(pool);
await pool.end();

// rawBody: webhook signatures (Nimbus) must be verified over the exact bytes received
const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: createLogger(), rawBody: true });
app.enableShutdownHooks();
app.set('trust proxy', 1); // behind the ALB
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Angular component styles are injected at runtime
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  }),
);
app.useBodyParser('json', { limit: '256kb' });
app.use(requestLogger);
app.use('/health', (_req: Request, res: Response) => res.send('ok'));
// shortcut: unauthenticated; the ALB only forwards /api, /sdk, /health and dashboard paths, never /metrics.
app.use('/metrics', async (_req: Request, res: Response) => res.type(registry.contentType).send(await registry.metrics()));

// Serve the built Angular dashboard from the same origin (no CORS, one container).
// resolve(): res.sendFile rejects relative paths, which broke deep links when DASHBOARD_DIR was relative.
const dashboard = resolve(process.env.DASHBOARD_DIR ?? join(import.meta.dirname, '../../dashboard/dist/dashboard/browser'));
if (existsSync(dashboard)) {
  app.useStaticAssets(dashboard);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/sdk')) return next();
    res.sendFile(join(dashboard, 'index.html'));
  });
}

await app.listen(Number(process.env.PORT ?? 4000));
