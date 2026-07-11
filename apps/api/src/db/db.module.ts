import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Env } from '../config/env';
import * as schema from './schema/index';
import { DB, PG_CLIENT } from './db.tokens';
import { TenantTransaction } from './tenant-transaction';

// Re-exported so existing `from '../db/db.module'` imports keep working. The
// definitions live in db.tokens to avoid a cycle with TenantTransaction.
export { DB, PG_CLIENT, type Database } from './db.tokens';

@Global()
@Module({
  providers: [
    {
      provide: PG_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        postgres(config.get('DATABASE_URL', { infer: true }), {
          max: config.get('DATABASE_POOL_MAX', { infer: true }),

          // Postgres DATE columns are business dates — plain calendar dates with
          // no timezone. postgres.js would hand us a JS Date in server-local time,
          // which is exactly the bug §6 warns about. Keep them as strings and let
          // @hotelos/domain's BusinessDate own them.
          types: {
            date: {
              to: 1082,
              from: [1082],
              serialize: (v: string) => v,
              parse: (v: string) => v,
            },
            // BIGINT money columns: parse to number, not string. Safe-integer
            // range covers ±90 trillion major units; Money asserts the invariant.
            bigint: {
              to: 20,
              from: [20],
              serialize: (v: number) => String(v),
              parse: (v: string) => {
                const n = Number(v);
                if (!Number.isSafeInteger(n)) {
                  throw new Error(`BIGINT ${v} exceeds JS safe-integer range`);
                }
                return n;
              },
            },
          },
        }),
    },
    {
      provide: DB,
      inject: [PG_CLIENT],
      useFactory: (client: postgres.Sql) => drizzle(client, { schema }),
    },

    // Lives here, not in AppModule. Every module that touches tenant data needs
    // it, and Nest providers are NOT inherited by child modules — declaring it in
    // AppModule left PropertyModule unable to resolve it. DbModule is @Global(),
    // so exporting it here makes it available everywhere without each feature
    // module importing a plumbing module.
    TenantTransaction,
  ],
  exports: [DB, PG_CLIENT, TenantTransaction],
})
export class DbModule implements OnApplicationShutdown {
  constructor() {}

  async onApplicationShutdown(): Promise<void> {
    // postgres.js drains its pool on process exit; nothing to do here yet.
    // Kept as the seam for graceful shutdown once the outbox relay is running.
  }
}
