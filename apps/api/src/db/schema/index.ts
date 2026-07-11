/**
 * Schema barrel. Each module owns its own Postgres schema (TDD §2.1); its Drizzle
 * tables live in src/modules/<name>/infra/schema.ts. This file re-exports them so
 * drizzle-kit sees one graph for migration generation.
 *
 * This is the ONE place cross-module schema imports are allowed — it is
 * infrastructure wiring, not a domain module reaching across a boundary.
 */
export * from './shared';
export * from '../../modules/identity/infra/schema';
export * from '../../modules/property/infra/schema';
