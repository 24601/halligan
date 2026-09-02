import { defineConfig, devices } from '@playwright/test';

/**
 * The cross-lane e2e contract. One spec per demo, each asserting: the route
 * loads, a pinned screenshot in BOTH themes reproduces from the seed, no
 * console errors, the CSP meta is present, no request leaves the origin, and
 * the keyboard reaches every control.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['dot']],
  timeout: 90_000,
  expect: {
    timeout: 20_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' },
  },
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1512, height: 982 },
    deviceScaleFactor: 1,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
