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
  text,
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
     * DEPRECATED — the old plaintext column. Kept only so this release is the
     * EXPAND step of expand → migrate → contract (TDD §10: "never destructive in
     * one release"). Dropping it in the same migration that adds the encrypted
     * columns would break any replica still running the previous build mid-deploy.
     *
     * Nothing reads or writes it any more. It is dropped in the contract migration
     * once every replica is on this build.
     */
    idNumberLegacy: varchar('id_number', { length: 64 }),

    /**
     * Passport / Aadhaar / licence number, AES-256-GCM encrypted (TDD §9).
     *
     * Postgres never sees the plaintext — encryption happens in the application
     * (see PiiCipher for why pgcrypto would have leaked the key into query logs).
     * A stolen dump or a misconfigured backup bucket yields nothing.
     */
    idNumberEncrypted: text('id_number_encrypted'),

    /**
     * Keyed blind index over the ID number, so we can look a returning guest up by
     * their passport without decrypting the table. HMAC, not a bare hash — see
     * PiiCipher.blindIndex.
     */
    idNumberHash: text('id_number_hash'),

    /** Last 4, for the front desk to eyeball. The full number needs an audited reveal. */
    idNumberMasked: varchar('id_number_masked', { length: 16 }),

    address: jsonb('address'),

    vip: boolean('vip').notNull().default(false),
    blacklisted: boolean('blacklisted').notNull().default(false),

    /** GDPR / DPDP erasure. The row survives (financial records reference it); the
     *  personal data does not. */
    anonymisedAt: timestamp('anonymised_at', { withTimezone: true }),

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
    // The whole point of the blind index: an exact lookup by ID number that never
    // touches the ciphertext.
    index('guests_id_hash_idx').on(t.propertyId, t.idNumberHash),
  ],
);
