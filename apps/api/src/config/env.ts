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

  /**
   * Guest PII encryption (TDD §9). 32 bytes, base64.
   *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   *
   * Losing this key means every stored ID number is unrecoverable. Rotating it
   * requires re-encrypting the column — the ciphertext carries a version tag so
   * that migration is possible.
   */
  PII_ENCRYPTION_KEY: z.string().min(44, 'PII_ENCRYPTION_KEY must be 32 bytes, base64-encoded'),

  /** Separate key for the blind index. Sharing one key across two purposes is how
   *  a weakness in one becomes a weakness in both. */
  PII_HASH_KEY: z.string().min(44, 'PII_HASH_KEY must be at least 32 bytes, base64-encoded'),

  // TDD §5.3 — query hardening
  GRAPHQL_DEPTH_LIMIT: z.coerce.number().int().positive().default(8),
  GRAPHQL_INTROSPECTION: z.coerce.boolean().default(false),

  // 'silent' is a real pino level and the one tests want — a full request log per
  // assertion buries the actual failure.
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Outbox relay (TDD §2). Disabled in tests, which drain it explicitly so the
  // assertions are deterministic rather than racing a background timer.
  OUTBOX_RELAY_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(1_000),
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
    // Two identical PII keys means the blind index and the cipher share a secret.
    // Cheap to check, catastrophic to get wrong.
    if (env.PII_ENCRYPTION_KEY === env.PII_HASH_KEY) {
      throw new Error('PII_ENCRYPTION_KEY and PII_HASH_KEY must be different keys.');
    }

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
