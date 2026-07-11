/**
 * inventory schema (TDD §4.2) — room types, rooms, rate plans, the daily rate grid.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  date,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { properties } from '../../property/infra/schema';

export const inventorySchema = pgSchema('inventory');

export const roomTypes = inventorySchema.table(
  'room_types',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),

    code: varchar('code', { length: 16 }).notNull(), // DLX, STD, SUITE
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),

    /** Rate is quoted for baseOccupancy; beyond it, extra-person charges apply. */
    baseOccupancy: integer('base_occupancy').notNull().default(2),
    maxOccupancy: integer('max_occupancy').notNull().default(2),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // Codes are per property: two hotels may both have a 'DLX'.
    unique('room_types_property_code_uq').on(t.propertyId, t.code),
    index('room_types_property_idx').on(t.propertyId),
  ],
);

export const rooms = inventorySchema.table(
  'rooms',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'restrict' }),

    /**
     * Not an integer — '12A', 'P-1' and '0101' are all real room numbers, and
     * '0101' must not become 101.
     */
    number: varchar('number', { length: 16 }).notNull(),
    floor: varchar('floor', { length: 16 }),

    // VACANT_CLEAN | VACANT_DIRTY | OCCUPIED | OOO | OOS
    status: varchar('status', { length: 16 }).notNull().default('VACANT_CLEAN'),

    /** Why the room is OOO/OOS. Shown to whoever has to explain it to a guest. */
    statusNote: text('status_note'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // TDD §4.2: UNIQUE(property_id, number). Two rooms numbered 101 in one hotel
    // is how a guest ends up at the wrong door.
    unique('rooms_property_number_uq').on(t.propertyId, t.number),
    index('rooms_property_idx').on(t.propertyId),
    index('rooms_type_idx').on(t.roomTypeId),
    // The room-status board and the tape chart both sort by this.
    index('rooms_status_idx').on(t.propertyId, t.status),
  ],
);

export const ratePlans = inventorySchema.table(
  'rate_plans',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),

    code: varchar('code', { length: 16 }).notNull(), // BAR, CORP, OTA
    name: varchar('name', { length: 100 }).notNull(),
    description: text('description'),

    currency: char('currency', { length: 3 }).notNull(),

    /** EP room-only · CP breakfast · MAP half-board · AP full-board. */
    mealPlan: varchar('meal_plan', { length: 8 }).notNull().default('EP'),

    active: varchar('active', { length: 8 }).notNull().default('true'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('rate_plans_property_code_uq').on(t.propertyId, t.code),
    index('rate_plans_property_idx').on(t.propertyId),
  ],
);

/**
 * The daily rate grid (TDD §4.2). One row per (plan, room type, date).
 *
 * Denormalised on purpose: hotel pricing is genuinely per-night — a Saturday in
 * season is not a Tuesday in monsoon — and a rules engine that derives it would
 * make the availability/quote path slow and unpredictable. 365 days × 10 types ×
 * 5 plans is 18k rows per property per year. That is nothing.
 */
export const ratePrices = inventorySchema.table(
  'rate_prices',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),

    ratePlanId: uuid('rate_plan_id')
      .notNull()
      .references(() => ratePlans.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'cascade' }),

    date: date('date').notNull(), // business date

    /** Minor units. Never a float — see @hotelos/domain money. */
    priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // One price per plan/type/date. The upsert in setRatePrices depends on this.
    unique('rate_prices_grid_uq').on(t.ratePlanId, t.roomTypeId, t.date),
    // The quote path: "price this room type on this plan across these nights."
    index('rate_prices_lookup_idx').on(t.propertyId, t.roomTypeId, t.date),
  ],
);
