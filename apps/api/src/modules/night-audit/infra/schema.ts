/**
 * reporting schema — the nightly snapshot (TDD §6 step 4).
 *
 * These numbers are FROZEN at audit time, not recomputed on demand. A hotel's
 * occupancy for last Tuesday must not change because someone cancelled a booking
 * today — the trading day is closed, the number was reported, and recomputing it
 * would silently rewrite history that people have already acted on.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  integer,
  pgSchema,
  primaryKey,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { properties } from '../../property/infra/schema';

export const reportingSchema = pgSchema('reporting');

export const dailyStats = reportingSchema.table(
  'daily_stats',
  {
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    businessDate: date('business_date').notNull(),

    /** Physical rooms that could have been sold (total minus out-of-order). */
    roomsAvailable: integer('rooms_available').notNull(),
    roomsSold: integer('rooms_sold').notNull(),
    roomsOutOfOrder: integer('rooms_out_of_order').notNull().default(0),

    /** Occupancy in basis points — 8543 = 85.43%. Integer, never a float. */
    occupancyBps: integer('occupancy_bps').notNull(),

    /** Room revenue only, NET of tax. Tax is the government's, not the hotel's. */
    roomRevenueMinor: bigint('room_revenue_minor', { mode: 'number' }).notNull(),
    /** Everything else — F&B, laundry. Also net. */
    otherRevenueMinor: bigint('other_revenue_minor', { mode: 'number' }).notNull().default(0),
    taxMinor: bigint('tax_minor', { mode: 'number' }).notNull().default(0),

    /** Average Daily Rate = room revenue / rooms SOLD. Zero if nothing sold. */
    adrMinor: bigint('adr_minor', { mode: 'number' }).notNull(),
    /** Revenue Per Available Room = room revenue / rooms AVAILABLE. */
    revparMinor: bigint('revpar_minor', { mode: 'number' }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // One snapshot per property per night. Re-running the audit overwrites it with
    // the same numbers rather than creating a second, contradictory row.
    primaryKey({ columns: [t.propertyId, t.businessDate] }),
    index('daily_stats_date_idx').on(t.propertyId, t.businessDate),
  ],
);
