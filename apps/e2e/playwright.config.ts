import { defineConfig } from '@playwright/test';

// The browser runs in Vietnam's time zone on purpose: Swedish delivery times must not shift with it.
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 150_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  outputDir: 'test-results/artifacts',
  use: {
    baseURL: 'http://localhost:13000',
    timezoneId: 'Asia/Ho_Chi_Minh',
    locale: 'en-GB',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
