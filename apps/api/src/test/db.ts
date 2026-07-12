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
 * The SAME type overrides the app installs (see DbModule).
 *
 * Without these, a test's raw client gets a Postgres DATE back as a JS Date in the
 * server's local timezone — the exact bug §6 exists to prevent. A test would then
 * be asserting on a value the application never sees, and the two would disagree
 * about what "2026-07-11" means somewhere around midnight.
 */
const TYPES = {
  date: {
    to: 1082,
    from: [1082],
    serialize: (v: string) => v,
    parse: (v: string) => v, // business dates stay strings, always
  },
} as const;

/**
 * Connects as the UNPRIVILEGED runtime role — the whole point. Connecting these
 * tests as the owner would make every RLS assertion pass vacuously, which is
 * exactly the trap that hid the superuser bug in the first place.
 */
export function appClient(): postgres.Sql {
  return postgres(APP_URL, { max: 2, onnotice: () => {}, types: TYPES as never });
}

/** Owner connection. Seeding and teardown only — never the subject of a test. */
export function ownerClient(): postgres.Sql {
  return postgres(OWNER_URL, { max: 2, onnotice: () => {}, types: TYPES as never });
}

export function appDb(client: postgres.Sql) {
  return drizzle(client, { schema });
}

/**
 * Delete only the rows belonging to the given properties, plus the org that owns
 * them. Owner-scoped so RLS doesn't hide rows from the cleanup itself.
 *
 * Deliberately NOT a TRUNCATE of every table. An earlier version did exactly that
 * and wiped identity.users — which is the SEED that auth.integration.test.ts
 * depends on. The suites then passed or failed purely on file order, and running
 * the tests destroyed the developer's local database. A test must clean up after
 * itself without reaching outside its own fixtures.
 */
export async function cleanupProperties(
  owner: postgres.Sql,
  propertyIds: readonly string[],
  organizationId: string,
): Promise<void> {
  if (propertyIds.length === 0) return;

  // The ::uuid[] cast is required: postgres.js sends a JS string array as text[],
  // and `uuid = ANY(text[])` has no operator in Postgres.
  const ids = propertyIds as string[];

  // Children first — FKs point at properties.
  await owner`DELETE FROM shared.audit_log             WHERE property_id = ANY(${ids}::uuid[])`;
  await owner`DELETE FROM shared.night_audit_runs      WHERE property_id = ANY(${ids}::uuid[])`;
  await owner`DELETE FROM identity.user_property_roles WHERE property_id = ANY(${ids}::uuid[])`;
  await owner`DELETE FROM property.taxes               WHERE property_id = ANY(${ids}::uuid[])`;
  await owner`DELETE FROM property.properties          WHERE id          = ANY(${ids}::uuid[])`;
  await owner`DELETE FROM property.organizations       WHERE id = ${organizationId}`;
}
