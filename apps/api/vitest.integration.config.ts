import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests against a real Postgres + Valkey via Testcontainers
 * (TDD §8.1): transactions, RLS, the exclusion constraint, the outbox.
 *
 * These exercise the guarantees that only exist in the database — an in-memory
 * fake would happily let you double-book a room.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    // Containers are slow to start; give them room and don't fight over ports.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
