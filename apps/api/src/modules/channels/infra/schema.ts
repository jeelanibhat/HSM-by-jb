/**
 * channel schema (Phase 2) — the connection to online travel agents.
 *
 * A channel manager does two things and this schema serves both:
 *
 *   OUT — when a room sells (or frees), the current availability is pushed to every
 *         connected OTA so they stop (or resume) selling it. `channel_outbound` is the
 *         queue of those pushes.
 *   IN  — when an OTA sells a room, it hands us the booking. `channel_bookings` records
 *         each delivery and links it to the reservation we created from it.
 *
 * Everything an OTA says is in ITS OWN vocabulary — its room codes, its rate codes, its
 * booking references. The two mapping tables translate that to our ids, and nothing
 * downstream ever sees an external code. A reservation created from a channel is an
 * ordinary reservation with `source = 'OTA'`; this schema is only the wiring.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { ratePlans, roomTypes } from '../../inventory/infra/schema';
import { properties } from '../../property/infra/schema';
import { reservations } from '../../reservations/infra/schema';

export const channelSchema = pgSchema('channel');

/** A connected external system — an OTA, or the simulated one used in dev and tests. */
export const channels = channelSchema.table(
  'channels',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),

    code: varchar('code', { length: 24 }).notNull(), // SIM_OTA, BOOKINGCOM
    name: varchar('name', { length: 100 }).notNull(),

    /**
     * Nothing sells through a channel until it is enabled AND mapped. Disabling it is
     * the "stop selling here" switch — the outbound worker skips disabled channels.
     */
    enabled: boolean('enabled').notNull().default(false),

    /**
     * Opaque per-connector settings and secrets. The simulated connector needs none; a
     * real one stores its API keys here, encrypted with the shared PII cipher. Kept out
     * of columns of their own so the connector, not the schema, owns its shape.
     */
    credentials: jsonb('credentials').notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('channel_channels_property_code_uq').on(t.propertyId, t.code),
    index('channel_channels_property_idx').on(t.propertyId),
  ],
);

/** Our room type ↔ the channel's room code. Both directions read through this. */
export const channelRoomTypeMappings = channelSchema.table(
  'channel_room_type_mappings',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'cascade' }),

    externalRoomCode: varchar('external_room_code', { length: 64 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // One of ours maps to exactly one of theirs, and vice versa — a code that meant two
    // room types would send the wrong availability, silently.
    unique('channel_rt_map_channel_roomtype_uq').on(t.channelId, t.roomTypeId),
    unique('channel_rt_map_channel_extcode_uq').on(t.channelId, t.externalRoomCode),
  ],
);

/** Our rate plan ↔ the channel's rate code. */
export const channelRatePlanMappings = channelSchema.table(
  'channel_rate_plan_mappings',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    ratePlanId: uuid('rate_plan_id')
      .notNull()
      .references(() => ratePlans.id, { onDelete: 'cascade' }),

    externalRateCode: varchar('external_rate_code', { length: 64 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('channel_rp_map_channel_rateplan_uq').on(t.channelId, t.ratePlanId),
    unique('channel_rp_map_channel_extcode_uq').on(t.channelId, t.externalRateCode),
  ],
);

/**
 * The outbound push queue.
 *
 * One row is "this channel needs the current availability for this room type over these
 * dates". It is enqueued the instant a booking moves inventory, and drained by a poller
 * that makes the actual (slow, flaky) call to the channel. The queue exists precisely so
 * that a channel being down cannot block the booking that triggered the push.
 */
export const channelOutbound = channelSchema.table(
  'channel_outbound',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'cascade' }),

    fromDate: date('from_date').notNull(),
    toDate: date('to_date').notNull(),

    /** PENDING | SENT | FAILED */
    status: varchar('status', { length: 16 }).notNull().default('PENDING'),

    attempts: integer('attempts').notNull().default(0),
    /** When the drainer may next try. Back-off pushes this into the future on failure. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    lastError: text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    // The drainer's query: due PENDING rows, oldest first.
    index('channel_outbound_due_idx').on(t.status, t.nextAttemptAt),
    index('channel_outbound_property_idx').on(t.propertyId, t.channelId),
  ],
);

/**
 * Every booking a channel has delivered, and what became of it.
 *
 * The unique key on (channel_id, external_ref) is load-bearing: OTAs redeliver, and this
 * is what turns the second delivery of a booking into a DUPLICATE instead of a second
 * reservation. `reservation_id` is set only once the booking is CONFIRMED.
 */
export const channelBookings = channelSchema.table(
  'channel_bookings',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),

    /** The OTA's own reference for this booking. */
    externalRef: varchar('external_ref', { length: 64 }).notNull(),

    reservationId: uuid('reservation_id').references(() => reservations.id, {
      onDelete: 'set null',
    }),

    /** RECEIVED | CONFIRMED | REJECTED | DUPLICATE */
    status: varchar('status', { length: 16 }).notNull().default('RECEIVED'),

    /** Why a booking was rejected — "no room left", "unknown rate code DELUXE-NR". */
    reason: text('reason'),

    /** What the channel sent, verbatim, for audit and for reprocessing a rejection. */
    rawPayload: jsonb('raw_payload').notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('channel_bookings_channel_ref_uq').on(t.channelId, t.externalRef),
    index('channel_bookings_property_idx').on(t.propertyId, t.channelId),
    index('channel_bookings_reservation_idx').on(t.reservationId),
  ],
);
