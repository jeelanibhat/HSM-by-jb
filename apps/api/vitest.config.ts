import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests only — pure domain/application logic, no I/O (TDD §8.1).
 * Integration tests (Testcontainers) live in vitest.integration.config.ts so a
 * `pnpm test` on a laptop without a container runtime still runs in seconds.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/modules/**/domain/**', 'src/modules/**/application/**', 'src/shared/**'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
  plugins: [
    // NestJS decorators need emitDecoratorMetadata, which esbuild cannot do.
    swc.vite({ module: { type: 'es6' } }),
  ],
});
