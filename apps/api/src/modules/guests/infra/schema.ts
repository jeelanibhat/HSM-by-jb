/**
 * guests schema (TDD §4.4).
 *
 * Minimal for now — reservations need a guest to point at. The full guest module
 * (profiles, history, search, PII encryption) is build step 7.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgSchema,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { properties } from '../../property/infra/schema';

export const guestsSchema = pgSchema('guests');

export const guests = guestsSchema.table(
  'guests',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),

    firstName: varchar('first_name', { length: 100 }).notNull(),
    lastName: varchar('last_name', { length: 100 }).notNull(),
    email: varchar('email', { length: 254 }),
    phone: varchar('phone', { length: 20 }),

    idType: varchar('id_type', { length: 32 }),
    /**
     * PII. TDD §9 requires column-level encryption at rest for this. Stored plain
     * for now and NOT exposed by any resolver yet; encryption lands with the guest
     * module in step 7, before any UI can read it back.
     */
    idNumber: varchar('id_number', { length: 64 }),

    address: jsonb('address'),

    vip: boolean('vip').notNull().default(false),
    blacklisted: boolean('blacklisted').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('guests_property_idx').on(t.propertyId),
    index('guests_name_idx').on(t.propertyId, t.lastName, t.firstName),
    index('guests_email_idx').on(t.propertyId, t.email),
    index('guests_phone_idx').on(t.propertyId, t.phone),
  ],
);
