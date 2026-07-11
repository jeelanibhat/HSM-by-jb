import { Inject } from '@nestjs/common';
import { Query, Resolver } from '@nestjs/graphql';
import { inArray } from 'drizzle-orm';
import { DB, type Database } from '../../../db/db.module';
import { TenantTransaction } from '../../../db/tenant-transaction';
import {
  CurrentUser,
  NoPropertyContext,
  PropertyId,
} from '../../identity';
import type { AuthenticatedUser } from '../../identity';
import { properties } from '../infra/schema';
import { PropertyType } from './property.types';

@Resolver()
export class PropertyResolver {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly tx: TenantTransaction,
  ) {}

  /**
   * The properties this user can work at — the property switcher in the UI.
   *
   * USER-scoped, not property-scoped: the question precedes the choice of a
   * property, so there is no tenant to scope to yet. The property_visibility
   * policy (migration 0004) resolves it against the user's own grants in the DB,
   * so even a bug in the WHERE clause below could not widen the result set beyond
   * the hotels this user actually works at.
   */
  @NoPropertyContext()
  @Query(() => [PropertyType])
  async myProperties(@CurrentUser() user: AuthenticatedUser): Promise<PropertyType[]> {
    const ids = user.roles.map((r) => r.propertyId);
    if (ids.length === 0) return [];

    return this.tx.runAsUser(user.id, async (tx) =>
      tx.select().from(properties).where(inArray(properties.id, ids)),
    );
  }

  /** The active property. Scoped, so RLS is the second line of defence. */
  @Query(() => PropertyType, { nullable: true })
  async currentProperty(@PropertyId() propertyId: string): Promise<PropertyType | null> {
    const rows = await this.tx.run(propertyId, async (tx) =>
      tx.select().from(properties),
    );

    // RLS narrows this to the one property; no WHERE clause needed, and none
    // would help if the GUC were wrong.
    return rows[0] ?? null;
  }
}
