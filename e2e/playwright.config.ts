import { defineConfig, devices } from '@playwright/test';

const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgres://flagship:flagship@localhost:5433/flagship_e2e';
const ADMIN_TOKEN = 'e2e-admin';
const PORT = 4950;

// Runs the real built API (which serves the built Angular dashboard) against a throwaway database.
export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    // Locally you can reuse an installed Chrome: CHROME_PATH=/usr/bin/google-chrome-stable
    launchOptions: process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: 'node start-server.mjs',
    url: `http://127.0.0.1:${PORT}/health`,
    env: { DATABASE_URL, ADMIN_TOKEN, PORT: String(PORT), DASHBOARD_DIR: '../apps/dashboard/dist/dashboard/browser' },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
