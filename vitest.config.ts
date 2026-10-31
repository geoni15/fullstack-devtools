import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/desktop/main/src/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
