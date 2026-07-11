/**
 * Schema barrel. Each module owns its own Postgres schema (TDD §2.1) and its
 * Drizzle tables live under src/modules/<name>/infra/schema.ts. This file
 * re-exports them so drizzle-kit sees one graph for migration generation.
 *
 * Populated as modules land (identity/property → inventory → reservations → …).
 */
export * from './shared.js';
