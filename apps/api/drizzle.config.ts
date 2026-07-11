import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://hotelos:hotelos@localhost:5432/hotelos',
  },
  // TDD §10: expand → migrate → contract. Never destructive in one release.
  strict: true,
  verbose: true,
});
