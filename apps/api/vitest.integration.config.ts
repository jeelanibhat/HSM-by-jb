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
     * One PROCESS PER FILE, run ONE FILE AT A TIME.
     *
     * `singleFork: false` — NestJS code-first GraphQL registers @ObjectType classes
     * in a process-global metadata registry. Booting a second Nest app in the same
     * process re-registers them and schema building dies with "multiple types named
     * PropertyRoleType". Each file needs a clean process.
     *
     * `fileParallelism: false` — every suite talks to the SAME Postgres. They share
     * the outbox table, the availability counters and Hotel Alpha's rooms. Running
     * them concurrently made the outbox concurrency test flaky (it asserts the queue
     * drains to empty, while a parallel suite was busy filling it) and would
     * eventually have produced far more confusing failures in the availability
     * counters. Isolated FIXTURES are not enough when the tables themselves are
     * shared; the suites must not overlap in time.
     *
     * Slower, deterministic. A flaky integration suite is worse than a slow one:
     * people learn to re-run it instead of reading it.
     */
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    fileParallelism: false,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
