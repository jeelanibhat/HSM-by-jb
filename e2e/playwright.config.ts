import { defineConfig, devices } from '@playwright/test';

const WEB = process.env['E2E_WEB_URL'] ?? 'http://localhost:3000';
const API = process.env['E2E_API_URL'] ?? 'http://localhost:4000';

export default defineConfig({
  testDir: './tests',
  globalSetup: './support/global-setup.ts',

  /**
   * ONE WORKER. Every spec drives the same Postgres and the same hotel: they book
   * the same rooms, move the same business date, and run the night audit. Parallel
   * workers would have them stealing each other's inventory and advancing the
   * trading day underneath one another.
   *
   * The integration suite (177 tests) already covers the logic in parallel-safe
   * isolation. E2E exists to prove the SCREENS wire up to it, and there are six of
   * those journeys. Determinism is worth more here than speed.
   */
  workers: 1,
  fullyParallel: false,

  // A flaky E2E suite gets re-run instead of read. One retry in CI covers a genuinely
  // slow cold compile; more than that would hide a real race.
  retries: process.env['CI'] ? 1 : 0,
  forbidOnly: Boolean(process.env['CI']),

  timeout: 90_000,
  expect: { timeout: 15_000 },

  reporter: process.env['CI']
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  /**
   * Run against the PRODUCTION build (TDD §8.3). A dev server compiles on first hit,
   * which turns a real 200ms interaction into a 20s one and hides genuine slowness.
   * `reuseExistingServer` locally so a dev with the stack already up is not made to
   * wait for a second copy.
   */
  webServer: [
    {
      command: 'pnpm --filter @hotelos/api start',
      url: `${API}/healthz`,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      cwd: '..',
    },
    {
      command: 'pnpm --filter @hotelos/web start',
      url: `${WEB}/login`,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      cwd: '..',
      env: { NEXT_PUBLIC_GRAPHQL_URL: `${API}/graphql` },
    },
  ],
});
