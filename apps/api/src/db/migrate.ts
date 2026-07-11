/**
 * Migration runner. Invoked by `pnpm db:migrate` and by CI before integration
 * tests. Kept separate from the app so a migration never runs implicitly on boot
 * — a rolling deploy with N replicas would otherwise race N migrations.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required to run migrations');

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
