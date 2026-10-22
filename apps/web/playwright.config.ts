import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const dist = fileURLToPath(new URL('./dist', import.meta.url));

/**
 * E2E tests run against the production build served by the real server
 * (in-memory store). Locally they use the installed Chrome; CI installs
 * Playwright's Chromium.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  fullyParallel: false,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: process.env.CI ? undefined : 'chrome' },
    },
  ],
  webServer: {
    // CI has pnpm on PATH (pnpm/action-setup); locally it comes via corepack.
    command: process.env.CI
      ? 'pnpm build && pnpm --filter @murmuration/server exec tsx src/main.ts'
      : 'corepack pnpm@9.15.0 build && corepack pnpm@9.15.0 --filter @murmuration/server exec tsx src/main.ts',
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      PUBLIC_DIR: dist,
      LOG_LEVEL: 'warn',
      MAX_CONNECTIONS_PER_IP: '1000',
      JOINS_PER_SECOND_PER_IP: '1000',
    },
  },
});
