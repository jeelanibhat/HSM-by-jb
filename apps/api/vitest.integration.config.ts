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

    env: {
      /**
       * The relay's background timer is OFF in tests. Tests call relay.drain()
       * explicitly, so assertions are deterministic instead of racing a 1s poll
       * that could process an event between the emit and the assertion.
       */
      OUTBOX_RELAY_ENABLED: 'false',

      // A request log line per assertion buries the actual failure.
      LOG_LEVEL: 'silent',
    },
    testTimeout: 60_000,
    hookTimeout: 120_000,

    /**
     * One PROCESS PER FILE — `singleFork` must stay false.
     *
     * NestJS code-first GraphQL registers @ObjectType classes in a process-global
     * metadata registry. Booting a second Nest app in the same process re-registers
     * them and schema building dies with "Schema must contain uniquely named types
     * but contains multiple types named PropertyRoleType". Any two integration
     * files that each stand up an app will collide.
     *
     * Separate processes give each file a clean registry. Suites are safe to run in
     * parallel because each owns isolated fixtures (its own property ids) and only
     * ever deletes its own rows.
     */
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
