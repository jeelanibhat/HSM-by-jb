/**
 * housekeeping schema (Phase 2) — the day's work on the rooms.
 *
 * A room's STATUS lives in inventory.rooms. This is the work: what each room needs
 * today, who is doing it, and whether anyone checked afterwards. Keeping them apart
 * matters — a room can be dirty with nobody assigned, clean but not inspected, or
 * inspected and sold. One column could not say all of that.
 */
import { sql } from 'drizzle-orm';
import {
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
import { users } from '../../identity/infra/schema';
import { rooms } from '../../inventory/infra/schema';
import { properties } from '../../property/infra/schema';

export const housekeepingSchema = pgSchema('housekeeping');

export const housekeepingTasks = housekeepingSchema.table(
  'tasks',
  {
    id: uuid('id').primaryKey(),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),

    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),

    /**
     * The hotel's trading day, not the calendar date. A task raised at 01:30 during
     * the night shift belongs to the day that has not closed yet — see business-date.
     */
    businessDate: date('business_date').notNull(),

    // DEPARTURE | STAYOVER | DEEP_CLEAN | TURNDOWN
    type: varchar('type', { length: 16 }).notNull(),

    // PENDING | IN_PROGRESS | DONE | INSPECTED
    status: varchar('status', { length: 16 }).notNull().default('PENDING'),

    /** Null = on the board, anyone may pick it up. */
    assignedTo: uuid('assigned_to').references(() => users.id, { onDelete: 'set null' }),

    /**
     * Cleaning credits — roughly minutes of work. A departure turnover is not a
     * turndown, and a supervisor splitting 40 rooms between 5 attendants needs to
     * split the WORK, not the room count.
     */
    credits: integer('credits').notNull().default(30),

    notes: text('notes'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    inspectedBy: uuid('inspected_by').references(() => users.id, { onDelete: 'set null' }),
    inspectedAt: timestamp('inspected_at', { withTimezone: true }),

    /** Why the inspection failed. The attendant is owed more than "failed". */
    inspectionNote: text('inspection_note'),

    /** How many times this room has been sent back. A 3 is a conversation. */
    failedInspections: integer('failed_inspections').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    /**
     * One task per room per type per day. This is what makes board generation
     * IDEMPOTENT: a supervisor hitting "generate" twice — or the night audit and a
     * supervisor doing it at the same moment — must not double the morning's work.
     * The constraint enforces it in the database, not in a hopeful `if` in the service.
     */
    unique('hk_tasks_room_date_type_uq').on(t.roomId, t.businessDate, t.type),

    // The board: "today's work at this hotel", the query this table exists to serve.
    index('hk_tasks_board_idx').on(t.propertyId, t.businessDate, t.status),

    // "My sheet" — an attendant's own tasks for the day.
    index('hk_tasks_assignee_idx').on(t.assignedTo, t.businessDate),
  ],
);
