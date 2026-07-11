/**
 * property schema (TDD §4.1). The `organization → property → outlet` hierarchy
 * exists from day one so Phase 4 multi-property groups need no migration.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  date,
  index,
  integer,
  pgSchema,
  time,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const propertySchema = pgSchema('property');

export const organizations = propertySchema.table('organizations', {
  id: uuid('id').primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export const properties = propertySchema.table(
  'properties',
  {
    id: uuid('id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 200 }).notNull(),

    /** IANA zone, e.g. 'Asia/Kolkata'. Needed to know when "tonight" is. */
    timezone: varchar('timezone', { length: 64 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),

    /**
     * THE business date (TDD §6). Not today's date. Advanced only by night
     * audit — every folio posting and every report keys off this value.
     */
    businessDate: date('business_date').notNull(),

    checkInTime: time('check_in_time').notNull().default('14:00'),
    checkOutTime: time('check_out_time').notNull().default('11:00'),

    status: varchar('status', { length: 16 }).notNull().default('ACTIVE'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('properties_org_idx').on(t.organizationId)],
);

/**
 * Tax configuration. Rates in basis points (1 bps = 0.01%) so 12% GST is 1200 —
 * an integer, because a float tax rate compounds rounding error across every
 * line of every folio.
 */
export const taxes = propertySchema.table(
  'taxes',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    rateBps: integer('rate_bps').notNull(),

    /** INCLUSIVE = already inside the rate; EXCLUSIVE = added on top. */
    type: varchar('type', { length: 16 }).notNull().default('EXCLUSIVE'),

    /**
     * Slab threshold: many jurisdictions (India GST) tax by room tariff band.
     * NULL = applies to every rate. Minor units.
     */
    appliesAboveMinor: bigint('applies_above_minor', { mode: 'number' }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('taxes_property_idx').on(t.propertyId)],
);
