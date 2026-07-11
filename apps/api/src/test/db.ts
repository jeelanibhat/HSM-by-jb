/**
 * Integration-test harness. Talks to a real Postgres — the guarantees under test
 * (RLS, exclusion constraints, transactional outbox) exist only in the database,
 * and an in-memory fake would happily let you double-book a room.
 *
 * Locally: `pnpm db:up` provides it. In CI: service containers do (see ci.yml).
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../db/schema/index';

const APP_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://hotelos_app:hotelos_app@localhost:5432/hotelos';

const OWNER_URL =
  process.env['DATABASE_MIGRATION_URL'] ?? 'postgresql://hotelos:hotelos@localhost:5432/hotelos';

/**
 * Connects as the UNPRIVILEGED runtime role — the whole point. Connecting these
 * tests as the owner would make every RLS assertion below pass vacuously, which
 * is exactly the trap that hid the bug in the first place.
 */
export function appClient(): postgres.Sql {
  return postgres(APP_URL, { max: 2, onnotice: () => {} });
}

/** Owner connection. Seeding and teardown only — never the subject of a test. */
export function ownerClient(): postgres.Sql {
  return postgres(OWNER_URL, { max: 2, onnotice: () => {} });
}

export function appDb(client: postgres.Sql) {
  return drizzle(client, { schema });
}

/** Wipe tenant data between tests. Owner-scoped so RLS doesn't hide rows from us. */
export async function truncateAll(owner: postgres.Sql): Promise<void> {
  await owner.unsafe(`
    TRUNCATE
      shared.audit_log,
      shared.outbox_events,
      shared.night_audit_runs,
      identity.user_property_roles,
      identity.users,
      property.taxes,
      property.properties,
      property.organizations
    RESTART IDENTITY CASCADE;
  `);
}
