import { Inject } from '@nestjs/common';
import { Field, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module.js';

@ObjectType()
export class Health {
  @Field()
  status!: string;

  @Field()
  database!: string;

  @Field()
  version!: string;
}

@Resolver()
export class HealthResolver {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Unauthenticated liveness probe. Deliberately leaks nothing but up/down —
   * no schema names, no versions, no connection strings.
   */
  @Query(() => Health)
  async health(): Promise<Health> {
    let database = 'down';
    try {
      await this.db.execute(sql`SELECT 1`);
      database = 'up';
    } catch {
      database = 'down';
    }

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      version: process.env.npm_package_version ?? '0.1.0',
    };
  }
}
