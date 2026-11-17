import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: { provider: 'v8', include: ['src/**'], reporter: ['text-summary', 'lcov'], thresholds: { lines: 90, branches: 85 } },
  },
});
