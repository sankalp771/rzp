import { defineConfig } from 'vitest/config';

// Single root runner so `pnpm test` covers every workspace package.
export default defineConfig({
  test: {
    include: [
      'packages/**/*.test.ts',
      'services/**/*.test.ts',
      'dashboard/**/*.test.ts',
      'evals/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Forked workers on Windows made each fastify test ~5s (process spawn
    // contention); threads bring the whole suite to ~3s. Revisit if a test
    // ever needs process-level isolation (e.g. env mutation).
    pool: 'threads',
    // Cold fastify import under CPU contention (Docker builds, CI noisy
    // neighbours) was observed to exceed the 5s default — see BUG-001.
    testTimeout: 15_000,
  },
});
