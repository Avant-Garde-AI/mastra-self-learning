import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      // Tests that touch storage need DATABASE_URL — they'll skip if not set.
      DATABASE_URL: process.env.DATABASE_URL ?? '',
    },
  },
});
