import { z } from 'zod';

/**
 * Fail fast on bad config. A server that boots with a missing JWT secret is
 * worse than one that refuses to boot.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  /**
   * Runtime connection. MUST be an unprivileged, non-owner role (hotelos_app):
   * a superuser or BYPASSRLS role silently defeats every RLS policy we have.
   * Asserted at boot below.
   */
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  /** Owner connection, migrations only. Never used to serve a request. */
  DATABASE_MIGRATION_URL: z.string().url().optional(),

  VALKEY_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'), // TDD §3: 15-minute access token
  JWT_REFRESH_TTL: z.string().default('7d'),

  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  // TDD §5.3 — query hardening
  GRAPHQL_DEPTH_LIMIT: z.coerce.number().int().positive().default(8),
  GRAPHQL_INTROSPECTION: z.coerce.boolean().default(false),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;

  /**
   * The app must not connect as the migration/owner role. If it does, Postgres
   * grants it the owner-bypass (and, for `postgres`/`hotelos`, the superuser
   * bypass) and every RLS policy stops applying — silently. A tenancy hole that
   * no test on a single property would ever catch.
   */
  const runtimeUser = new URL(env.DATABASE_URL).username;
  if (runtimeUser === 'postgres' || runtimeUser === 'hotelos') {
    throw new Error(
      `DATABASE_URL connects as '${runtimeUser}', which owns the schema and bypasses ` +
        `Row-Level Security. Use the unprivileged app role (hotelos_app). ` +
        `Migrations use DATABASE_MIGRATION_URL.`,
    );
  }

  // Dev-only secrets must never reach production.
  if (env.NODE_ENV === 'production') {
    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      if (env[key].includes('dev-only')) {
        throw new Error(`${key} still holds the development placeholder. Refusing to start.`);
      }
    }
    if (env.GRAPHQL_INTROSPECTION) {
      throw new Error('GraphQL introspection must be disabled in production.');
    }
  }

  return env;
}
