import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Env } from '../config/env.js';
import * as schema from './schema/index.js';

export const DB = Symbol('DB');
export const PG_CLIENT = Symbol('PG_CLIENT');

export type Database = ReturnType<typeof drizzle<typeof schema>>;

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
  ],
  exports: [DB, PG_CLIENT],
})
export class DbModule implements OnApplicationShutdown {
  constructor() {}

  async onApplicationShutdown(): Promise<void> {
    // postgres.js drains its pool on process exit; nothing to do here yet.
    // Kept as the seam for graceful shutdown once the outbox relay is running.
  }
}
