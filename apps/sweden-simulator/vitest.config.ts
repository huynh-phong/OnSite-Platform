import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The integration suites share one test database.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
