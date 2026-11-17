import { defineConfig } from 'vitest/config';

// Black-box: spawns two built API replicas against a real Postgres (see docs/TEST_PLAN.md).
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false } });
