/**
 * Migration runner. Invoked by `pnpm db:migrate` and by CI before integration
 * tests. Kept separate from the app so a migration never runs implicitly on boot
 * — a rolling deploy with N replicas would otherwise race N migrations.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function main(): Promise<void> {
  /**
   * Migrations run as the schema OWNER, not as the app role — they create tables,
   * define RLS policies, and grant privileges, none of which the unprivileged
   * runtime role can (or should) do.
   */
  const url = process.env['DATABASE_MIGRATION_URL'] ?? process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_MIGRATION_URL (or DATABASE_URL) is required to run migrations');
  }

  // max: 1 — migrations must run serially on a single connection.
  const client = postgres(url, { max: 1 });

  try {
    await migrate(drizzle(client), { migrationsFolder: './drizzle' });
    console.warn('Migrations applied.');
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
