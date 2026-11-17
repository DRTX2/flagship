import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { createPool, migrate, PG } from './db/db.js';
import { AdminController } from './admin.controller.js';
import { SdkController } from './sdk.controller.js';
import { FlagsService } from './flags.service.js';
import { AdminGuard, SdkGuard } from './http.js';

@Module({
  controllers: [AdminController, SdkController],
  providers: [{ provide: PG, useFactory: createPool }, FlagsService, AdminGuard, SdkGuard],
})
class AppModule {}

const pool = createPool();
await migrate(pool);
await pool.end();

const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.enableShutdownHooks();
app.use('/health', (_req: Request, res: Response) => res.send('ok'));

// Serve the built Angular dashboard from the same origin (no CORS, one container).
const dashboard = process.env.DASHBOARD_DIR ?? join(import.meta.dirname, '../../dashboard/dist/dashboard/browser');
if (existsSync(dashboard)) {
  app.useStaticAssets(dashboard);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/sdk')) return next();
    res.sendFile(join(dashboard, 'index.html'));
  });
}

await app.listen(Number(process.env.PORT ?? 4000));
