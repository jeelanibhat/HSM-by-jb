/**
 * reservations schema (TDD §4.3) — "the heart".
 *
 * Two guarantees here exist ONLY in the database, and deliberately so:
 *
 *   1. `no_double_booking` — a GiST exclusion constraint. Even if every line of
 *      application code were wrong, Postgres will not let the same room be held
 *      by two overlapping stays. Added in the migration; Drizzle cannot express it.
 *
 *   2. `room_type_availability` — denormalised counters, updated in the SAME
 *      transaction as the reservation write, under SELECT ... FOR UPDATE. This is
 *      what makes an availability check O(nights) instead of a scan over every
 *      reservation, and what makes two people racing for the last room serialise.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { properties } from '../../property/infra/schema';
import { ratePlans, rooms, roomTypes } from '../../inventory/infra/schema';
import { guests } from '../../guests/infra/schema';

export const reservationsSchema = pgSchema('reservations');

export const reservations = reservationsSchema.table(
  'reservations',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),

    /** What the guest is told on the phone. Unique per property. */
    confirmationNo: varchar('confirmation_no', { length: 20 }).notNull(),

    guestId: uuid('guest_id')
      .notNull()
      .references(() => guests.id, { onDelete: 'restrict' }),

    // ENQUIRY | CONFIRMED | CHECKED_IN | CHECKED_OUT | CANCELLED | NO_SHOW
    status: varchar('status', { length: 16 }).notNull(),

    // WALK_IN | DIRECT | PHONE | OTA | BOOKING_ENGINE
    source: varchar('source', { length: 16 }).notNull(),

    /** BUSINESS dates, not timestamps. The stay is half-open: [arrival, departure). */
    arrivalDate: date('arrival_date').notNull(),
    departureDate: date('departure_date').notNull(),

    adults: integer('adults').notNull().default(1),
    children: integer('children').notNull().default(0),
    notes: text('notes'),

    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),

    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('reservations_confirmation_uq').on(t.propertyId, t.confirmationNo),
    index('reservations_property_status_idx').on(t.propertyId, t.status),
    // Arrivals and departures lists (TDD §5.2) hit these every morning.
    index('reservations_arrival_idx').on(t.propertyId, t.arrivalDate),
    index('reservations_departure_idx').on(t.propertyId, t.departureDate),
    index('reservations_guest_idx').on(t.guestId),

    // A zero-night stay is not a stay. Mirrors nightsBetween() in the domain.
    check('reservations_dates_valid', sql`${t.departureDate} > ${t.arrivalDate}`),
  ],
);

/**
 * One reservation can hold several rooms (a family taking two rooms, a group).
 * Each row is one room, for one date range, on one rate plan.
 */
export const reservationRooms = reservationsSchema.table(
  'reservation_rooms',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),

    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),

    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'restrict' }),

    /**
     * NULL until a specific room is assigned. A reservation sells a room TYPE;
     * the physical room is picked later (often at check-in). The exclusion
     * constraint only bites once this is set — which is exactly right: two
     * unassigned bookings for the same type are not a double-booking, they are
     * two rooms of that type being sold.
     */
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'restrict' }),

    ratePlanId: uuid('rate_plan_id')
      .notNull()
      .references(() => ratePlans.id, { onDelete: 'restrict' }),

    /** Per-room dates: a room move or a shortened stay changes THIS row, not the reservation. */
    arrivalDate: date('arrival_date').notNull(),
    departureDate: date('departure_date').notNull(),

    /**
     * Denormalised from the parent reservation, and kept in step with it in the
     * same transaction. The exclusion constraint's WHERE clause needs it on THIS
     * row — a partial index cannot reach into another table.
     */
    status: varchar('status', { length: 16 }).notNull(),

    adults: integer('adults').notNull().default(1),
    children: integer('children').notNull().default(0),

    checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('res_rooms_reservation_idx').on(t.reservationId),
    index('res_rooms_room_idx').on(t.roomId),
    index('res_rooms_type_dates_idx').on(t.propertyId, t.roomTypeId, t.arrivalDate),

    check('res_rooms_dates_valid', sql`${t.departureDate} > ${t.arrivalDate}`),
  ],
);

/**
 * Denormalised availability counters (TDD §4.3).
 *
 *   available = total - sold - blocked,  per room type, per night
 *
 * A room type is bookable for [arrival, departure) iff that is > 0 for EVERY
 * night in the range. Counters are updated inside the reservation transaction,
 * so the check is O(nights) rather than a scan of every reservation ever made.
 */
export const roomTypeAvailability = reservationsSchema.table(
  'room_type_availability',
  {
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),

    /** Physical rooms of this type. */
    total: integer('total').notNull().default(0),
    /** Held by a live reservation (not cancelled, not no-show). */
    sold: integer('sold').notNull().default(0),
    /** Out of order / out of service on this date. */
    blocked: integer('blocked').notNull().default(0),

    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.propertyId, t.roomTypeId, t.date] }),

    /**
     * You cannot sell more rooms than physically exist, and you cannot release a
     * room twice. If a bug ever tried, the write fails loudly here rather than
     * quietly corrupting the counters — which would surface days later as a guest
     * with a confirmation and no room.
     *
     * Deliberately `sold <= total`, NOT `sold + blocked <= total`. Blocking rooms
     * is a business decision (a burst pipe on a sold-out night), and it can
     * legitimately push a property into overbooking that staff then resolve by
     * moving guests. That is an operational problem, not a data-integrity
     * violation — and a CHECK that rejected it would make it impossible to even
     * RECORD the burst pipe.
     */
    check('availability_never_oversold', sql`${t.sold} >= 0 AND ${t.sold} <= ${t.total}`),
  ],
);
