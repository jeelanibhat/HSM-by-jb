/**
 * Tenant-scoped transactions — the enforcement point for TDD §2.2.
 *
 * Row-Level Security is only defence-in-depth if something actually sets the
 * tenant GUC. Every domain write and every tenant read must go through here:
 * we open a transaction, `SET LOCAL app.property_id`, and run the callback.
 *
 * SET LOCAL is scoped to the transaction, so the value cannot leak to the next
 * caller that borrows this pooled connection — which is precisely why we do not
 * use a plain `SET`.
 */
import { Injectable, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from './db.module.js';

/** A transaction handle already scoped to one property. */
export type TenantTx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantTransaction {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Run `fn` inside a transaction bound to `propertyId`. RLS policies on every
   * tenant table compare `property_id` against the GUC set here, so a query that
   * forgets its WHERE clause returns nothing instead of another hotel's guests.
   */
  async run<T>(propertyId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    // The GUC is set by string interpolation (set_config takes a literal), so we
    // must be certain this is a UUID and not an injection vector. The value comes
    // from a validated JWT claim, but defence-in-depth means never trusting that
    // upstream validation held.
    if (!UUID_RE.test(propertyId)) {
      throw new Error(`Refusing to open a tenant transaction with a non-UUID property id`);
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.property_id', ${propertyId}, true)`);
      return fn(tx);
    });
  }

  /**
   * Escape hatch for genuinely cross-tenant work: login (we don't know the
   * property yet), the outbox relay, and Phase 4 group reporting. Named loudly
   * so it shows up in review.
   */
  async runWithoutTenantScope<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }
}
