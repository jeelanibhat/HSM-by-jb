/**
 * pos schema (Phase 2) — outlets, the menu, and the orders that become folio lines.
 *
 * The point of the module is the last three words. An order is not an invoice and it
 * is not a payment: it is a claim that becomes a CHARGE ON A GUEST'S BILL, computed
 * and taxed by the folio, in the folio's ledger. This schema stores what the
 * restaurant did; folio.folio_lines remains the single source of truth for what the
 * guest owes.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
import { folios } from '../../folio/infra/schema';
import { users } from '../../identity/infra/schema';
import { rooms } from '../../inventory/infra/schema';
import { properties } from '../../property/infra/schema';

export const posSchema = pgSchema('pos');

/** A place that sells things — the restaurant, the bar, the spa, room service. */
export const outlets = posSchema.table(
  'outlets',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),

    code: varchar('code', { length: 16 }).notNull(), // RESTAURANT, BAR, SPA
    name: varchar('name', { length: 100 }).notNull(),

    /**
     * The folio charge code every sale here posts under — RESTAURANT, BAR, MINIBAR.
     * It is what the guest reads on their bill and what the revenue report groups by,
     * so it belongs to the OUTLET, not to each menu item.
     */
    chargeCode: varchar('charge_code', { length: 16 }).notNull(),

    active: boolean('active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('pos_outlets_property_code_uq').on(t.propertyId, t.code),
    index('pos_outlets_property_idx').on(t.propertyId),
  ],
);

export const menuItems = posSchema.table(
  'menu_items',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    outletId: uuid('outlet_id')
      .notNull()
      .references(() => outlets.id, { onDelete: 'cascade' }),

    code: varchar('code', { length: 24 }).notNull(),
    name: varchar('name', { length: 120 }).notNull(),
    category: varchar('category', { length: 40 }),

    /** Minor units. Never a float — see @hotelos/domain money. */
    priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),

    active: boolean('active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('pos_menu_items_outlet_code_uq').on(t.outletId, t.code),
    index('pos_menu_items_outlet_idx').on(t.outletId, t.active),
  ],
);

export const orders = posSchema.table(
  'orders',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    outletId: uuid('outlet_id')
      .notNull()
      .references(() => outlets.id, { onDelete: 'restrict' }),

    /** Human-readable, per property — "R-00042". What the waiter shouts. */
    orderNo: varchar('order_no', { length: 24 }).notNull(),

    /** OPEN | CHARGED | VOID */
    status: varchar('status', { length: 16 }).notNull().default('OPEN'),

    tableRef: varchar('table_ref', { length: 40 }),

    /** The hotel's trading day. A 1am dessert belongs to the day that has not closed. */
    businessDate: date('business_date').notNull(),

    /**
     * Where it was charged. Set at exactly one moment, together with status=CHARGED,
     * in the same transaction that writes the folio lines.
     */
    folioId: uuid('folio_id').references(() => folios.id, { onDelete: 'restrict' }),
    roomId: uuid('room_id').references(() => rooms.id, { onDelete: 'set null' }),

    /** What the folio was charged, tax excluded. The tax lines live on the folio. */
    chargedSubtotalMinor: bigint('charged_subtotal_minor', { mode: 'number' }),
    chargedAt: timestamp('charged_at', { withTimezone: true }),

    voidReason: text('void_reason'),

    openedBy: uuid('opened_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('pos_orders_property_no_uq').on(t.propertyId, t.orderNo),

    /**
     * ONE order can be charged ONCE.
     *
     * A partial unique index on the folio id would not say this — an order is charged
     * to a folio, but a folio takes many orders. What must be unique is the ORDER's
     * charged-ness, and `status` plus this constraint on (id) is trivially that. The
     * real defence is in the service: SELECT ... FOR UPDATE, then the state machine,
     * which refuses CHARGED → CHARGED. A double-tap on "send to room" hits the lock
     * and then the machine.
     */
    index('pos_orders_board_idx').on(t.propertyId, t.status, t.businessDate),
    index('pos_orders_folio_idx').on(t.folioId),
  ],
);

export const orderLines = posSchema.table(
  'order_lines',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),

    menuItemId: uuid('menu_item_id')
      .notNull()
      .references(() => menuItems.id, { onDelete: 'restrict' }),

    /**
     * The name and price AS SOLD, copied at the moment the line was added.
     *
     * Not a join to menu_items at read time. The kitchen re-prices the club sandwich
     * next Tuesday, and a bill printed after that must still say what the guest was
     * actually charged on the night. A menu is a price list; an order line is history.
     */
    description: varchar('description', { length: 120 }).notNull(),
    unitPriceMinor: bigint('unit_price_minor', { mode: 'number' }).notNull(),
    quantity: integer('quantity').notNull(),

    notes: varchar('notes', { length: 200 }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('pos_order_lines_order_idx').on(t.orderId)],
);
