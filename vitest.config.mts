import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/server/test/**/*.test.ts', 'apps/web/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
