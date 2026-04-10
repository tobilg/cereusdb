import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ['tests/**/*.test.ts'],
  },
});
