import { Global, Module, type OnApplicationShutdown, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { Env } from '../config/env';

/**
 * Valkey — sessions, the refresh-token revocation list, hot availability cache,
 * and (from build step 6) GraphQL subscription pub/sub.
 *
 * Valkey is the BSD-licensed fork of Redis 7.2 and speaks the same wire protocol,
 * so `ioredis` is the client either way. Nothing here is Valkey-specific.
 */
export const VALKEY = Symbol('VALKEY');

@Global()
@Module({
  providers: [
    {
      provide: VALKEY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new Redis(config.get('VALKEY_URL', { infer: true }), {
          maxRetriesPerRequest: 3,
          // A front desk mid-check-in should get an error, not a 30s hang.
          connectTimeout: 5_000,
          lazyConnect: false,
        }),
    },
  ],
  exports: [VALKEY],
})
export class ValkeyModule implements OnApplicationShutdown {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.valkey.quit();
  }
}
