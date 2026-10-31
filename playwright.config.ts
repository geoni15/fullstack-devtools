import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './apps/desktop/e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});
