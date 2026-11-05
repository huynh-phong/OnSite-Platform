import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests share one running stack and must not interleave.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
