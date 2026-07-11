import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      // TDD §8.4 — 80% gate on domain logic
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
