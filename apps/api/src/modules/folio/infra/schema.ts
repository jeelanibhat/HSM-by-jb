/**
 * folio schema (TDD §4.4) — the guest's bill.
 *
 * TWO RULES SHAPE EVERYTHING HERE.
 *
 * 1. LINES ARE IMMUTABLE. "corrections are reversing entries, never updates" (§4.4).
 *    Enforced in the database: no UPDATE or DELETE policy, and the privilege is
 *    revoked outright. An accountant can prove what the bill said at any moment in
 *    its history, because nothing can ever have been quietly edited.
 *
 * 2. SIGNED AMOUNTS. A positive line increases what the guest owes; a negative one
 *    decreases it. The balance is therefore a plain SUM — no CASE over line types,
 *    no chance of a new line type being forgotten in the balance query and silently
 *    not counting. Payments and reversals are stored negative.
 *
 * DEVIATION FROM THE TDD, ON PURPOSE. §4.4 sketches `voided_by` / `void_reason`
 * columns on folio_lines. Those cannot exist alongside immutability — setting them
 * IS an update. Instead a void inserts a reversing line pointing at the original
 * via `reverses_line_id`. "Is this line voided?" becomes "does a line reverse it?",
 * and the ledger stays append-only, which is what §6 actually asks for.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  date,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { properties } from '../../property/infra/schema';
import { guests } from '../../guests/infra/schema';
import { reservations } from '../../reservations/infra/schema';

export const folioSchema = pgSchema('folio');

export const folios = folioSchema.table(
  'folios',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),

    reservationId: uuid('reservation_id').references(() => reservations.id, {
      onDelete: 'restrict',
    }),
    guestId: uuid('guest_id')
      .notNull()
      .references(() => guests.id, { onDelete: 'restrict' }),

    folioNo: varchar('folio_no', { length: 20 }).notNull(),

    /** OPEN → CLOSED (checked out, balance zero) → SETTLED. */
    status: varchar('status', { length: 16 }).notNull().default('OPEN'),

    /** GUEST · MASTER (group bill) · CITY_LEDGER (invoice a company). */
    type: varchar('type', { length: 16 }).notNull().default('GUEST'),

    currency: char('currency', { length: 3 }).notNull(),

    closedAt: timestamp('closed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('folios_property_no_uq').on(t.propertyId, t.folioNo),
    index('folios_reservation_idx').on(t.reservationId),
    index('folios_guest_idx').on(t.guestId),
    index('folios_property_status_idx').on(t.propertyId, t.status),
  ],
);

export const folioLines = folioSchema.table(
  'folio_lines',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),

    folioId: uuid('folio_id')
      .notNull()
      .references(() => folios.id, { onDelete: 'restrict' }),

    /**
     * BUSINESS date, not the wall clock (TDD §6). A charge posted at 01:00 belongs
     * to yesterday's trading day until night audit says otherwise. Every report
     * keys off this.
     */
    businessDate: date('business_date').notNull(),

    /** CHARGE | PAYMENT | TAX | ADJUSTMENT */
    type: varchar('type', { length: 16 }).notNull(),

    /** ROOM, F&B, LAUNDRY, CASH, CARD, UPI ... */
    code: varchar('code', { length: 32 }).notNull(),
    description: varchar('description', { length: 255 }).notNull(),

    /**
     * SIGNED minor units. Positive = the guest owes more. Payments and reversals
     * are negative. Balance is a plain SUM of this column.
     */
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),

    /** Tax carried on this line, for invoice breakdown. Also signed. */
    taxAmountMinor: bigint('tax_amount_minor', { mode: 'number' }).notNull().default(0),

    /**
     * Set on a reversing line, pointing at the line it cancels. The original is
     * never touched — that is what makes the ledger append-only.
     */
    reversesLineId: uuid('reverses_line_id'),

    /**
     * Set on a TAX line, pointing at the CHARGE it taxes.
     *
     * Without this link, voiding a charge leaves its tax behind: the guest keeps
     * paying GST on a line that no longer exists, and the hotel remits tax it never
     * collected. The tax is not an independent economic event — it exists only
     * because the charge does, so it must die with it.
     */
    parentLineId: uuid('parent_line_id'),
    /** Why. Required on a reversal (TDD §7.4). */
    reason: text('reason'),

    /** Which module posted this — reservations, folio, night-audit, pos. */
    sourceModule: varchar('source_module', { length: 32 }).notNull().default('folio'),

    postedBy: uuid('posted_by'),

    /**
     * No `updated_at`. There is no update. Its absence is the point — a column
     * nobody can set is a column nobody has to wonder about.
     */
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('folio_lines_folio_idx').on(t.folioId, t.createdAt),
    index('folio_lines_date_idx').on(t.propertyId, t.businessDate),
    index('folio_lines_reverses_idx').on(t.reversesLineId),
    // Voiding a charge has to find its tax lines.
    index('folio_lines_parent_idx').on(t.parentLineId),
  ],
);

export const invoices = folioSchema.table(
  'invoices',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),

    folioId: uuid('folio_id')
      .notNull()
      .references(() => folios.id, { onDelete: 'restrict' }),

    invoiceNo: varchar('invoice_no', { length: 24 }).notNull(),

    /** Frozen snapshot: gross, tax breakdown, net, paid. The folio may keep moving. */
    totals: jsonb('totals').notNull(),

    issuedAt: timestamp('issued_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('invoices_property_no_uq').on(t.propertyId, t.invoiceNo),
    index('invoices_folio_idx').on(t.folioId),
  ],
);
